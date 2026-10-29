import numpy as np
import pandas as pd
from retention.analysis import (
    CUTOFF,
    FEATURES,
    build_cohort,
    cohort_flow,
    load_data,
    metrics,
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
