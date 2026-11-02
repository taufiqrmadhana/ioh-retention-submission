import hashlib
import json
import math

import numpy as np
import pandas as pd
from retention.analysis import (
    ARTIFACTS,
    CODE,
    CUTOFF,
    DEPENDENCIES,
    FEATURES,
    INPUTS,
    ROOT,
    build_cohort,
    cohort_flow,
    load_data,
    main,
    manifest,
    metrics,
    rule_check,
    segment_rule,
    smoothed_isotonic,
    subgroup_table,
)


def test_future_records_and_resolution_status_cannot_change_features():
    base, usage, support = load_data()
    original = build_cohort(base, usage, support)
    future = support.iloc[[0]].copy()
    future["customerId"] = original.iloc[0].customerId
    future["date"] = CUTOFF
    future["topic"] = "technical_issue"
    changed = pd.concat([support, future], ignore_index=True)
    changed["resolutionStatus"] = "Pending"
    newer = usage.iloc[[0]].copy()
    newer["customerId"] = original.iloc[0].customerId
    newer["available_at"] = pd.Timestamp("2025-12-01")
    newer["monthlyCharges"] = 999999999
    altered = build_cohort(base, pd.concat([usage, newer]), changed)
    pd.testing.assert_frame_equal(original[FEATURES], altered[FEATURES])


def test_snapshot_excludes_already_churned_and_has_no_feature_label():
    f = build_cohort(*load_data())
    assert len(f) == 208 and f.label.sum() == 41
    assert f.customerId.is_unique
    assert (f.available_at == CUTOFF).all()
    assert not (f.churnDate < CUTOFF).any()
    assert not set(FEATURES) & {
        "churnDate",
        "label",
        "gender",
        "age",
        "resolutionStatus",
        "customerId",
    }


def test_uninformative_scores_have_expected_lift_one_with_ties():
    y = np.array([1, 1, 0, 0, 0, 0, 0, 0, 0, 0])
    result = metrics(y, np.repeat(0.2, 10))
    assert result["lift_at_20pct"] == 1
    assert result["precision_at_20pct"] == 0.2


def test_cohort_flow_accounts_for_every_source_customer():
    base, usage, support = load_data()
    frame = build_cohort(base, usage, support)
    flow = cohort_flow(base, usage, frame)
    assert flow["churned_before_snapshot"] + flow["not_churned_before_snapshot"] == len(base)
    assert flow["not_churned_before_snapshot"] - flow["excluded_no_october_usage"] == len(frame)
    reasons = flow["excluded_reasons"]
    assert (
        reasons["first_usage_in_november_or_later"]
        + reasons["last_usage_before_october"]
        + reasons["no_usage_rows"]
        == flow["excluded_no_october_usage"]
    )
    assert flow["november_churners_in_cohort"] == flow["november_churners_in_files"] == 41


def test_group_recall_uses_one_global_cutoff():
    """A per-group top-20% quota caps recall when a group holds many churners."""
    frame = pd.DataFrame({"region": ["A"] * 5 + ["B"] * 5})
    y = pd.Series([1, 1, 1, 0, 0, 0, 0, 0, 0, 0])
    scores = np.array([0.9, 0.8, 0.7, 0.1, 0.1, 0.2, 0.2, 0.2, 0.2, 0.2])
    rows = {r["group"]: r for r in subgroup_table(frame, y, scores, columns=("region",))}
    # Global top 20% = 2 customers, both in A: recall 2/3 at the shared cutoff.
    assert rows["A"]["recall_at_global_top20pct"] == 2 / 3
    assert rows["A"]["flagged_at_global_top20pct"] == 2
    # A's own quota is 1 slot, so within-group recall cannot exceed 1/3.
    assert rows["A"]["recall_within_group_top20pct"] == rows["A"]["recall_ceiling_within_group"] == 1 / 3
    assert rows["B"]["recall_at_global_top20pct"] is None


def test_smoothed_isotonic_is_monotone_and_never_certain():
    scores = np.array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8])
    labels = np.array([0, 0, 0, 0, 1, 1, 1, 1])
    predict = smoothed_isotonic(scores, labels)
    fitted = predict(scores)
    assert np.all(np.diff(fitted) >= 0)
    assert 0 < fitted.min() and fitted.max() < 1
    assert fitted[0] == 1 / 6  # zero churners in a block of four, plus one of each
    assert predict([0.0])[0] == fitted[0] and predict([0.95])[0] == fitted[-1]
    assert predict([0.45])[0] == fitted[3]  # step function: nearest lower training score


def test_rule_check_counts_the_segment():
    frame = build_cohort(*load_data())
    scores = np.linspace(0, 1, len(frame))
    check = rule_check(frame, frame.label, scores)
    rows = {r["approach"]: r for r in check["rows"]}
    assert rows["segment_rule"]["flagged"] == segment_rule(frame).sum() == 53
    assert rows["segment_rule"]["churners"] == 41
    assert rows["segment_no_contact_rule"]["flagged"] <= rows["segment_rule"]["flagged"]
    assert check["within_segment"]["n"] == 53


def test_committed_outputs_match_sources_and_each_other():
    report = json.loads((ROOT / "outputs" / "report.json").read_text())
    intelligence = json.loads((ROOT / "outputs" / "intelligence.json").read_text())
    provenance = json.loads((ROOT / "outputs" / "manifest.json").read_text())
    cohort = pd.read_csv(ROOT / "outputs" / "cohort.csv")
    current = manifest()
    assert report["manifest"] == intelligence["manifest"] == current
    assert report["run_id"] == intelligence["run_id"] == provenance["run_id"] == current["run_id"]
    assert set(cohort.run_id) == {current["run_id"]}
    assert set(current["code_sha256"]) == set(CODE)
    assert set(current["input_sha256"]) == set(INPUTS)
    assert set(current["dependency_sha256"]) == set(DEPENDENCIES)
    assert set(provenance["artifact_sha256"]) == set(ARTIFACTS)
    for name, digest in provenance["artifact_sha256"].items():
        assert hashlib.sha256((ROOT / "outputs" / name).read_bytes()).hexdigest() == digest
    by_id = cohort.set_index("customerId")
    for customer in intelligence["customers"]:
        row = by_id.loc[customer["customer_id"]]
        assert customer["calibration_method"] == "nested_held_out_smoothed_isotonic"
        assert customer["calibrated_risk"] == round(row.calibrated_risk, 6)
        assert customer["fitted_calibrated_risk"] == round(row.fitted_calibrated_risk, 6)


def assert_close(fresh, committed, path=""):
    """Exact match, except floats may differ in the last digits across machines."""
    if isinstance(fresh, float) or isinstance(committed, float):
        assert math.isclose(fresh, committed, rel_tol=1e-6, abs_tol=1e-9), path
    elif isinstance(fresh, dict):
        assert fresh.keys() == committed.keys(), path
        for key in fresh:
            assert_close(fresh[key], committed[key], f"{path}/{key}")
    elif isinstance(fresh, list):
        assert len(fresh) == len(committed), path
        for i, (a, b) in enumerate(zip(fresh, committed)):
            assert_close(a, b, f"{path}[{i}]")
    else:
        assert fresh == committed, path


def test_isolated_regeneration_matches_committed_artifacts(tmp_path):
    main(output_dir=tmp_path)
    hint = "differs on regeneration; rerun `python -m retention analyze`"
    for name in ("report.json", "intelligence.json"):
        fresh = json.loads((tmp_path / name).read_text())
        committed = json.loads((ROOT / "outputs" / name).read_text())
        assert_close(fresh, committed, f"{name} {hint}")
    pd.testing.assert_frame_equal(
        pd.read_csv(tmp_path / "cohort.csv"),
        pd.read_csv(ROOT / "outputs" / "cohort.csv"),
        check_exact=False,
        rtol=1e-6,
        atol=1e-9,
    )
    # Artifact hashes depend on float bytes, so they are checked against the
    # committed files in test_committed_outputs_match_sources_and_each_other.
    fresh = json.loads((tmp_path / "manifest.json").read_text())
    committed = json.loads((ROOT / "outputs" / "manifest.json").read_text())
    fresh.pop("artifact_sha256")
    committed.pop("artifact_sha256")
    assert fresh == committed, f"manifest.json {hint}"
