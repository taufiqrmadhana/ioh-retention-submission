"""Run with `uv run python -m retention analyze` from the repository root.

The score is a retrospective out-of-fold estimate, not a validated production
probability. Outcome columns never enter the exported decision intelligence.
"""

from pathlib import Path
import hashlib
import json
import math

import numpy as np
import pandas as pd
from sklearn.calibration import CalibratedClassifierCV
from sklearn.compose import ColumnTransformer
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    average_precision_score,
    brier_score_loss,
    log_loss,
    roc_auc_score,
)
from sklearn.model_selection import StratifiedKFold, train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler
from sklearn.tree import DecisionTreeClassifier

from retention import decisions, policy

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
CUTOFF = pd.Timestamp("2025-11-01")
END = pd.Timestamp("2025-12-01")
SEED = 42
NUMERIC = [
    "tenureMonths",
    "monthlyCharges",
    "dataUsageGB",
    "support_30d",
    "technical_30d",
    "billing_30d",
]
CATEGORICAL = ["contractType", "paymentMethod", "hasInternetService"]
FEATURES = NUMERIC + CATEGORICAL


def load_data(root=DATA):
    base = pd.read_csv(root / "customer_base.csv")
    usage = pd.read_csv(root / "service_usage.csv")
    support = pd.read_csv(root / "support_interactions.csv")
    base["churnDate"] = pd.to_datetime(base["churnDate"])
    base["region"] = (
        base.region.str.strip()
        .str.lower()
        .replace({"jkt": "jakarta", "sby": "surabaya", "bdg": "bandung"})
        .str.title()
    )
    usage["month"] = pd.to_datetime(usage.yearMonth + "-01")
    usage["available_at"] = usage.month + pd.offsets.MonthBegin(1)
    usage["totalCharges"] = pd.to_numeric(usage.totalCharges, errors="coerce")
    support["date"] = support.interactionDate.map(
        lambda x: pd.to_datetime(x, format="%d/%m/%Y" if "/" in x else "%Y-%m-%d")
    )
    support["topic"] = (
        support.supportTopic.str.strip().str.lower().str.replace(" ", "_")
    )
    return base, usage, support


def build_cohort(base, usage, support, cutoff=CUTOFF, horizon_end=END):
    """Fresh prior-month usage only; alive at cutoff; full next-month label.

    Assumptions: monthly usage is available on the next month's first day,
    profiles are stable, churn registry is complete through 30 Nov 2025.
    Resolution status is excluded because there is no status-effective timestamp.
    """
    latest = usage[usage.available_at == cutoff].copy()
    frame = latest.merge(base, on="customerId", validate="one_to_one")
    frame = frame[frame.churnDate.isna() | (frame.churnDate >= cutoff)].copy()
    past = support[
        (support.date < cutoff) & (support.date >= cutoff - pd.Timedelta(days=30))
    ]
    for col, topic in [
        ("support_30d", None),
        ("technical_30d", "technical_issue"),
        ("billing_30d", "billing_inquiry"),
    ]:
        selected = past if topic is None else past[past.topic == topic]
        frame[col] = (
            frame.customerId.map(selected.groupby("customerId").size())
            .fillna(0)
            .astype(int)
        )
    frame["label"] = (
        (frame.churnDate >= cutoff) & (frame.churnDate < horizon_end)
    ).astype(int)
    return frame.sort_values("customerId").reset_index(drop=True)


def model(estimator=None):
    numeric = Pipeline(
        [("impute", SimpleImputer(strategy="median")), ("scale", StandardScaler())]
    )
    categoric = Pipeline(
        [
            ("impute", SimpleImputer(strategy="most_frequent")),
            ("encode", OneHotEncoder(handle_unknown="ignore")),
        ]
    )
    prep = ColumnTransformer(
        [("numeric", numeric, NUMERIC), ("categoric", categoric, CATEGORICAL)]
    )
    return Pipeline(
        [
            ("prep", prep),
            (
                "model",
                estimator
                if estimator is not None
                else LogisticRegression(C=0.3, max_iter=2000, random_state=SEED),
            ),
        ]
    )


def metrics(y, scores):
    y, scores = np.asarray(y), np.asarray(scores)
    k = max(1, math.ceil(len(y) * 0.2))
    # Expected selection at the cutoff for tied scores; no ID/order advantage.
    threshold = np.sort(scores)[-k]
    above, tied = scores > threshold, scores == threshold
    positives = float(y[above].sum() + (k - above.sum()) * y[tied].mean())
    precision = positives / k
    return {
        "n": len(y),
        "positives": int(y.sum()),
        "prevalence": float(y.mean()),
        "pr_auc": float(average_precision_score(y, scores)),
        "roc_auc": float(roc_auc_score(y, scores)),
        "brier": float(brier_score_loss(y, scores)),
        "top_k": k,
        "precision_at_20pct": precision,
        "recall_at_20pct": positives / float(y.sum()),
        "lift_at_20pct": precision / float(y.mean()),
    }


def interval(y, p, draws=1000):
    """Bootstrap 95% interval for PR-AUC; resamples with a single class are skipped."""
    y, p = np.asarray(y), np.asarray(p)
    rng = np.random.default_rng(SEED)
    values = []
    for _ in range(draws):
        idx = rng.integers(0, len(y), len(y))
        if len(np.unique(y[idx])) == 2:
            values.append(average_precision_score(y[idx], p[idx]))
    return [float(v) for v in np.quantile(values, [0.025, 0.975])]


def cohort_flow(base, usage, frame, cutoff=CUTOFF, horizon_end=END):
    """Why customers in the files are, or are not, in the decision cohort.

    Inclusion needs an October usage row. Every November churner has one, but
    most other customers do not, so the cohort churn rate describes customers
    with observable October usage, not every customer active on 1 November.
    """
    churned_before = base.churnDate < cutoff
    alive = base[~churned_before]
    first_seen = usage.groupby("customerId").month.min()
    last_seen = usage.groupby("customerId").month.max()
    excluded = alive[~alive.customerId.isin(frame.customerId)]
    first = excluded.customerId.map(first_seen)
    last = excluded.customerId.map(last_seen)
    later = excluded[first >= cutoff]
    later_tenure = later.customerId.map(
        usage[usage.month >= cutoff].groupby("customerId").tenureMonths.min()
    )
    november_churn = base[(base.churnDate >= cutoff) & (base.churnDate < horizon_end)]
    in_cohort_churn = int(frame.label.sum())
    return {
        "source_customers": len(base),
        "churned_before_snapshot": int(churned_before.sum()),
        "not_churned_before_snapshot": len(alive),
        "excluded_no_october_usage": len(excluded),
        "excluded_reasons": {
            "first_usage_in_november_or_later": len(later),
            "of_which_tenure_2_plus_months": int((later_tenure >= 2).sum()),
            "last_usage_before_october": int((last < cutoff - pd.offsets.MonthBegin(1)).sum()),
            "no_usage_rows": int(first.isna().sum()),
        },
        "cohort": len(frame),
        "november_churners_in_files": len(november_churn),
        "november_churners_in_cohort": in_cohort_churn,
        "cohort_churn_rate": in_cohort_churn / len(frame),
        "churn_rate_if_all_not_churned_were_active": len(november_churn) / len(alive),
        "note": (
            "Cohort = customers with an October usage row and no churn before 1 Nov. All November "
            "churners have that row; most non-churners do not, so inclusion depends on the outcome. "
            "The cohort rate is the churn rate among observable customers, not the churn rate of the "
            "active base, and model metrics inherit this selection."
        ),
    }


def audit(base, usage, support):
    linked = usage.merge(
        base[["customerId", "churnDate"]], on="customerId", validate="many_to_one"
    )
    contacts = support.merge(
        base[["customerId", "churnDate"]], on="customerId", validate="many_to_one"
    )
    coverage = []
    for dt in sorted(usage.available_at.unique()):
        cut = pd.Timestamp(dt)
        c = build_cohort(base, usage, support, cut, cut + pd.offsets.MonthBegin(1))
        coverage.append(
            {
                "snapshot": str(cut.date()),
                "customers": len(c),
                "churn": int(c.label.sum()) if cut < END else None,
                "non_churn": int(len(c) - c.label.sum()) if cut < END else None,
                "label_observed": bool(cut < END),
            }
        )
    counts = usage.groupby("customerId").size()
    return {
        "customers": len(base),
        "churn_records": int(base.churnDate.notna().sum()),
        "usage_rows": len(usage),
        "support_rows": len(support),
        "one_usage_row": int((counts == 1).sum()),
        "two_usage_rows": int((counts == 2).sum()),
        "missing_usage": int((~base.customerId.isin(usage.customerId)).sum()),
        "blank_total_charges": int(usage.totalCharges.isna().sum()),
        "usage_in_churn_month": int(
            (linked.month == linked.churnDate.dt.to_period("M").dt.to_timestamp()).sum()
        ),
        "support_after_churn": int((contacts.date > contacts.churnDate).sum()),
        "coverage": coverage,
        "sources": {
            name: hashlib.sha256((DATA / name).read_bytes()).hexdigest()
            for name in [
                "customer_base.csv",
                "service_usage.csv",
                "support_interactions.csv",
            ]
        },
    }


def evaluate_holdout(frame, X, y, train, test):
    """Compare the pre-specified models on the 25% holdout; nothing is tuned on it."""
    fitted = model().fit(X.iloc[train], y.iloc[train])
    predictions = fitted.predict_proba(X.iloc[test])[:, 1]
    comparison = {"logistic_regression": metrics(y.iloc[test], predictions)}
    comparison["logistic_regression"]["pr_auc_bootstrap_95pct"] = interval(
        y.iloc[test], predictions
    )
    tree = model(
        DecisionTreeClassifier(max_depth=3, min_samples_leaf=15, random_state=SEED)
    ).fit(X.iloc[train], y.iloc[train])
    comparison["shallow_tree"] = metrics(
        y.iloc[test], tree.predict_proba(X.iloc[test])[:, 1]
    )
    comparison["constant_prevalence"] = metrics(
        y.iloc[test], np.repeat(y.iloc[train].mean(), len(test))
    )
    rule = (
        (frame.contractType == "Month-to-month").astype(float) * 0.5
        + (frame.tenureMonths < 6).astype(float) * 0.3
        + (frame.technical_30d > 0).astype(float) * 0.2
    )
    # A ranking rule is not a probability model, so it has no Brier score.
    comparison["business_rule"] = {
        **metrics(y.iloc[test], rule.iloc[test]),
        "brier": None,
    }
    return comparison, predictions


def overlap_sensitivity(X, y, train, test, predictions):
    """Re-score the holdout without customers whose features match a training row."""
    fingerprints = X.fillna("__missing__").astype(str).agg("|".join, axis=1)
    overlap = fingerprints.iloc[test].isin(set(fingerprints.iloc[train])).to_numpy()
    return {
        "exact_feature_overlap_test_rows": int(overlap.sum()),
        "distinct_feature_vectors_in_cohort": int(fingerprints.nunique()),
        "nonoverlap_holdout": metrics(y.iloc[test][~overlap], predictions[~overlap]),
        "note": "Post-evaluation diagnostic, not used for model selection. Exact feature matches are different customer IDs; similarity may inflate internal performance.",
    }


def top_signals(fitted, X, rows, top=4):
    """Largest per-customer log-odds contributions of a fitted logistic pipeline."""
    transformed = fitted.named_steps["prep"].transform(X)
    if hasattr(transformed, "toarray"):
        transformed = transformed.toarray()
    contributions = transformed * fitted.named_steps["model"].coef_[0]
    names = fitted.named_steps["prep"].get_feature_names_out()
    signals = {}
    for row, contrib in zip(rows, contributions):
        signals[int(row)] = [
            {
                "feature": names[j].split("__", 1)[1],
                "contribution_log_odds": round(float(contrib[j]), 3),
                "direction": "increases risk" if contrib[j] > 0 else "decreases risk",
            }
            for j in np.argsort(-np.abs(contrib))[:top]
        ]
    return signals


def out_of_fold(X, y):
    """Five-fold scores, so no customer is scored by a model that saw them."""
    scores = np.zeros(len(X))
    folds = np.zeros(len(X), dtype=int)
    signals = {}
    cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=SEED)
    for fold, (fit, val) in enumerate(cv.split(X, y), 1):
        fitted = model().fit(X.iloc[fit], y.iloc[fit])
        scores[val] = fitted.predict_proba(X.iloc[val])[:, 1]
        folds[val] = fold
        signals.update(top_signals(fitted, X.iloc[val], val))
    return scores, folds, signals


def calibration_table(y, scores, bins=5):
    return [
        {
            "n": len(bucket),
            "mean_score": float(scores[bucket].mean()),
            "observed_rate": float(y.iloc[bucket].mean()),
        }
        for bucket in np.array_split(np.argsort(scores), bins)
    ]


def global_flags(scores, share=0.2):
    """Expected selection of each customer at one cohort-wide top-share cutoff.

    Tied scores at the cutoff share the remaining slots, as in `metrics`.
    """
    scores = np.asarray(scores)
    k = max(1, math.ceil(len(scores) * share))
    threshold = np.sort(scores)[-k]
    above, tied = scores > threshold, scores == threshold
    flags = above.astype(float)
    flags[tied] = (k - above.sum()) / tied.sum()
    return flags


def calibrated_model():
    """Platt (sigmoid) scaling; the calibrator is fitted on internal folds of its training rows."""
    return CalibratedClassifierCV(
        model(),
        method="sigmoid",
        cv=StratifiedKFold(n_splits=5, shuffle=True, random_state=SEED),
    )


def probability_scores(y, scores):
    y, scores = np.asarray(y), np.asarray(scores)
    return {
        "brier": float(brier_score_loss(y, scores)),
        "log_loss": float(log_loss(y, np.clip(scores, 1e-6, 1 - 1e-6), labels=[0, 1])),
        "pr_auc": float(average_precision_score(y, scores)),
    }


def calibration_check(X, y, train, test, holdout_raw, oof_raw, folds):
    """Does sigmoid calibration improve probability error? Reported, never auto-applied.

    Holdout: calibrated on the 75% training rows only. Out-of-fold: inside each of the
    same five outer folds used for the shipped scores, so no customer's own label
    calibrates its score.
    """
    holdout_cal = (
        calibrated_model()
        .fit(X.iloc[train], y.iloc[train])
        .predict_proba(X.iloc[test])[:, 1]
    )
    oof_cal = np.zeros(len(X))
    for fold in np.unique(folds):
        fit, val = folds != fold, folds == fold
        oof_cal[val] = (
            calibrated_model().fit(X[fit], y[fit]).predict_proba(X[val])[:, 1]
        )
    y_test = y.iloc[test]
    return {
        "method": "Sigmoid (Platt) scaling via CalibratedClassifierCV, 5 internal folds, fitted on training rows only.",
        "holdout": {
            "raw": probability_scores(y_test, holdout_raw),
            "sigmoid": probability_scores(y_test, holdout_cal),
        },
        "out_of_fold": {
            "raw": probability_scores(y, oof_raw),
            "sigmoid": probability_scores(y, oof_cal),
        },
        "calibration_sigmoid_oof": calibration_table(y, oof_cal),
        "shipped_scores": "raw out-of-fold logistic",
    }, oof_cal


def subgroup_table(frame, y, scores, columns=("gender", "region")):
    """Descriptive churn, score and recall by group; not a fairness certification.

    Recall is measured at one cohort-wide top-20% cutoff, so groups are compared
    under the same rule. A separate top-20% quota per group caps recall at
    quota / churners whenever a group holds more churners than its quota.
    """
    flags = global_flags(scores)
    rows = []
    for col in columns:
        groups = frame.groupby(frame[col].fillna("Unknown")).groups
        for group, indexes in groups.items():
            idx = np.array(list(indexes))
            yy, pp, ff = y.iloc[idx].to_numpy(), scores[idx], flags[idx]
            positives = int(yy.sum())
            quota = max(1, math.ceil(len(idx) * 0.2))
            rows.append(
                {
                    "dimension": col,
                    "group": str(group),
                    "n": len(idx),
                    "positive_count": positives,
                    "observed_rate": float(yy.mean()),
                    "mean_score": float(pp.mean()),
                    "flagged_at_global_top20pct": round(float(ff.sum()), 3),
                    "recall_at_global_top20pct": float((ff * yy).sum() / positives)
                    if positives
                    else None,
                    "group_quota_top20pct": quota,
                    "recall_within_group_top20pct": float(
                        yy[np.argsort(-pp, kind="stable")[:quota]].sum() / positives
                    )
                    if positives
                    else None,
                    "recall_ceiling_within_group": min(1.0, quota / positives)
                    if positives
                    else None,
                    "caution": "Descriptive only; small subgroup; no fairness certification. Compare groups at the global cutoff; the within-group figure is capped by its quota.",
                }
            )
    return rows


def risk_band(score):
    return "High" if score >= 0.5 else "Medium" if score >= 0.2 else "Low"


def evidence(row):
    """Plain-language reasons a reviewer can check against the source systems."""
    reasons = []
    if row.technical_30d:
        reasons.append("Recent technical contact; current resolution must be verified.")
    if row.billing_30d:
        reasons.append("Recent billing contact; issue details must be verified.")
    if row.tenureMonths < 6:
        reasons.append("Short tenure: under six months.")
    if row.contractType == "Month-to-month":
        reasons.append("Month-to-month contract.")
    return reasons or ["No recent support signal in the supplied extract."]


def customer_records(frame, usage, scores, folds, signals):
    """Decision records without outcome columns; consent and eligibility stay unknown."""
    history = usage[usage.available_at <= CUTOFF].groupby("customerId").size()
    records = []
    for i, row in frame.iterrows():
        features = {
            c: str(row[c])
            if c in CATEGORICAL
            else float(row[c])
            if pd.notna(row[c])
            else None
            for c in FEATURES
        }
        records.append(
            {
                "customer_id": row.customerId,
                "region": row.region,
                "risk_score": round(float(scores[i]), 6),
                "risk_band": risk_band(scores[i]),
                "features": features,
                "evidence": evidence(row),
                "model_signals": signals[i],
                "data_quality": "Partial history",
                "history_months_at_snapshot": int(history.get(row.customerId, 0)),
                "consent": "unknown",
                "eligibility": "review_required",
                "resolution_status": "unknown_at_snapshot",
                "last_contact_at": None,
                "score_method": "out_of_fold_logistic",
                "fold": int(folds[i]),
            }
        )
    return records


def limitations(overlap_rows, flow):
    return [
        f"Cohort inclusion depends on the outcome: all {flow['november_churners_in_cohort']} November churners have the October usage row that inclusion needs, while {flow['excluded_no_october_usage']} customers not churned by 1 Nov lack it. The {flow['cohort_churn_rate']:.1%} rate and the model metrics describe this observable cohort, not the whole active base.",
        "No out-of-time validation: early snapshots are heavily outcome-selected.",
        "Churn registry completeness through 30 November is assumed, not documented.",
        "Profiles lack effective timestamps; historical stability is assumed.",
        "Support resolution status is excluded: no status-effective timestamp.",
        "Random customer holdout is internal validation in one selected historical cohort.",
        f"{overlap_rows} holdout customers share exact model features with training customers; non-overlap sensitivity is reported separately.",
        "OOF demo scores are retrospective estimates, not production-calibrated probabilities.",
        "No treatment/control data: benefits are scenario assumptions, not measured uplift.",
        "Gender, age, partner and dependents are excluded from scoring; proxies may remain.",
    ]


def main():
    out = ROOT / "outputs"
    out.mkdir(exist_ok=True)
    base, usage, support = load_data()
    frame = build_cohort(base, usage, support)
    X, y = frame[FEATURES], frame.label
    train, test = train_test_split(
        np.arange(len(frame)), test_size=0.25, stratify=y, random_state=SEED
    )
    comparison, predictions = evaluate_holdout(frame, X, y, train, test)
    sensitivity = overlap_sensitivity(X, y, train, test, predictions)
    oof, folds, signals = out_of_fold(X, y)
    calibration, oof_sigmoid = calibration_check(X, y, train, test, predictions, oof, folds)
    flow = cohort_flow(base, usage, frame)
    report = {
        "snapshot": "2025-11-01",
        "horizon_end_exclusive": "2025-12-01",
        "seed": SEED,
        "cohort": {
            "n": len(frame),
            "churn": int(y.sum()),
            "prevalence": float(y.mean()),
            "train": len(train),
            "test": len(test),
        },
        "cohort_flow": flow,
        "evaluation": comparison,
        "sensitivity": sensitivity,
        "oof": metrics(y, oof),
        "calibration": calibration_table(y, oof),
        "calibration_check": calibration,
        "subgroups": subgroup_table(frame, y, oof),
        "audit": audit(base, usage, support),
        "limitations": limitations(sensitivity["exact_feature_overlap_test_rows"], flow),
    }
    customers = customer_records(frame, usage, oof, folds, signals)
    # Retrospective labels for reporting only; they never enter intelligence.json.
    labels = dict(zip(frame.customerId, y.astype(int)))
    policy_base = {"budget": 3_000_000, "max_customers": 10}
    report["economics"] = {
        "sensitivity": decisions.sensitivity_curve(customers, policy_base),
        "optimisation": decisions.optimisation_gap(customers, policy_base),
        "strategies": decisions.strategy_comparison(customers, policy_base, labels),
        "decision_curve": decisions.decision_curve(y.iloc[test].to_numpy(), predictions),
    }
    report["calibration_check"]["plan_impact"] = decisions.plan_impact(
        customers, dict(zip(frame.customerId, oof_sigmoid)), policy_base, labels
    )
    report["targeting"] = decisions.targeting_diagnostic(customers, policy_base)
    report["pilot"] = decisions.pilot_design(customers, labels, policy_base)
    intelligence = {
        "snapshot": report["snapshot"],
        "model_version": "lr-oof-v1-seed42",
        "policy_version": policy.POLICY_VERSION,
        "mode": "retrospective_demo",
        "customers": customers,
    }
    (out / "report.json").write_text(json.dumps(report, indent=2, allow_nan=False))
    (out / "intelligence.json").write_text(
        json.dumps(intelligence, indent=2, allow_nan=False)
    )
    frame.assign(oof_score=oof, fold=folds).to_csv(out / "cohort.csv", index=False)
    print(
        f"Cohort: {len(frame)} customers | Holdout: {len(test)} | Average precision: {comparison['logistic_regression']['pr_auc']:.3f}\nResults saved to {out}"
    )


if __name__ == "__main__":
    main()
