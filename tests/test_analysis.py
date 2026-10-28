import numpy as np
import pandas as pd
from retention.analysis import load_data, build_cohort, FEATURES, CUTOFF, metrics


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
