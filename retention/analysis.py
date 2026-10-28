"""Run with `uv run python -m retention analyze` from the repository root.

The score is a retrospective out-of-fold estimate, not a validated production
probability. Outcome columns never enter the exported decision intelligence.
"""

from pathlib import Path
import hashlib
import json
import math

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, roc_auc_score, brier_score_loss
from sklearn.model_selection import StratifiedKFold, train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler
from sklearn.tree import DecisionTreeClassifier

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


def interval(y, p):
    rng = np.random.default_rng(SEED)
    values = []
    for _ in range(1000):
        idx = rng.integers(0, len(y), len(y))
        if len(set(np.asarray(y)[idx])) == 2:
            values.append(
                average_precision_score(np.asarray(y)[idx], np.asarray(p)[idx])
            )
    return [float(v) for v in np.quantile(values, [0.025, 0.975])]


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


def main():
    out = ROOT / "outputs"
    out.mkdir(exist_ok=True)
    base, usage, support = load_data()
    frame = build_cohort(base, usage, support)
    X, y = frame[FEATURES], frame.label
    train, test = train_test_split(
        np.arange(len(frame)), test_size=0.25, stratify=y, random_state=SEED
    )
    fixed_model = model().fit(X.iloc[train], y.iloc[train])
    predictions = fixed_model.predict_proba(X.iloc[test])[:, 1]
    comparison = {"logistic_regression": metrics(y.iloc[test], predictions)}
    comparison["logistic_regression"]["pr_auc_bootstrap_95pct"] = interval(
        y.iloc[test], predictions
    )
    fingerprints = X.fillna("__missing__").astype(str).agg("|".join, axis=1)
    overlap = fingerprints.iloc[test].isin(set(fingerprints.iloc[train])).to_numpy()
    sensitivity = {
        "exact_feature_overlap_test_rows": int(overlap.sum()),
        "distinct_feature_vectors_in_cohort": int(fingerprints.nunique()),
        "nonoverlap_holdout": metrics(y.iloc[test][~overlap], predictions[~overlap]),
        "note": "Post-evaluation diagnostic, not used for model selection. Exact feature matches are different customer IDs; similarity may inflate internal performance.",
    }
    # Pre-specified comparator, never selected or tuned on the test set.
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
    comparison["business_rule"] = metrics(y.iloc[test], rule.iloc[test])
    comparison["business_rule"]["brier"] = (
        None  # Ranking rule is not a probability model.
    )
    # Cohort-wide demo scores are genuinely out of fold; not fitted-row scores.
    oof = np.zeros(len(frame))
    signals = {}
    folds = np.zeros(len(frame), dtype=int)
    cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=SEED)
    for fold, (fit, val) in enumerate(cv.split(X, y), 1):
        m = model().fit(X.iloc[fit], y.iloc[fit])
        oof[val] = m.predict_proba(X.iloc[val])[:, 1]
        folds[val] = fold
        transformed = m.named_steps["prep"].transform(X.iloc[val])
        if hasattr(transformed, "toarray"):
            transformed = transformed.toarray()
        contributions = transformed * m.named_steps["model"].coef_[0]
        names = m.named_steps["prep"].get_feature_names_out()
        for row_index, contrib in zip(val, contributions):
            ix = np.argsort(-np.abs(contrib))[:4]
            signals[int(row_index)] = [
                {
                    "feature": names[j].split("__", 1)[1],
                    "contribution_log_odds": round(float(contrib[j]), 3),
                    "direction": "increases risk"
                    if contrib[j] > 0
                    else "decreases risk",
                }
                for j in ix
            ]
    calibration = []
    for bucket in np.array_split(np.argsort(oof), 5):
        calibration.append(
            {
                "n": len(bucket),
                "mean_score": float(oof[bucket].mean()),
                "observed_rate": float(y.iloc[bucket].mean()),
            }
        )
    fairness = []
    for col in ["gender", "region"]:
        for group, indexes in frame.groupby(
            frame[col].fillna("Unknown")
        ).groups.items():
            idx = np.array(list(indexes))
            yy = y.iloc[idx].to_numpy()
            pp = oof[idx]
            k = max(1, math.ceil(len(idx) * 0.2))
            fairness.append(
                {
                    "dimension": col,
                    "group": str(group),
                    "n": len(idx),
                    "positive_count": int(yy.sum()),
                    "observed_rate": float(yy.mean()),
                    "mean_score": float(pp.mean()),
                    "recall_at_20pct": float(yy[np.argsort(-pp)[:k]].sum() / yy.sum())
                    if yy.sum()
                    else None,
                    "caution": "Descriptive only; small subgroup; no fairness certification.",
                }
            )
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
        "evaluation": comparison,
        "sensitivity": sensitivity,
        "oof": metrics(y, oof),
        "calibration": calibration,
        "subgroups": fairness,
        "audit": audit(base, usage, support),
        "limitations": [
            "No out-of-time validation: early snapshots are heavily outcome-selected.",
            "Churn registry completeness through 30 November is assumed, not documented.",
            "Profiles lack effective timestamps; historical stability is assumed.",
            "Support resolution status is excluded: no status-effective timestamp.",
            "Random customer holdout is internal validation in one selected historical cohort.",
            f"{int(overlap.sum())} holdout customers share exact model features with training customers; non-overlap sensitivity is reported separately.",
            "OOF demo scores are retrospective estimates, not production-calibrated probabilities.",
            "No treatment/control data: benefits are scenario assumptions, not measured uplift.",
            "Gender, age, partner and dependents are excluded from scoring; proxies may remain.",
        ],
    }
    customers = []
    for i, row in frame.iterrows():
        features = {
            c: (
                str(row[c])
                if c in CATEGORICAL
                else float(row[c])
                if pd.notna(row[c])
                else None
            )
            for c in FEATURES
        }
        evidence = []
        if row.technical_30d:
            evidence.append(
                "Recent technical contact; current resolution must be verified."
            )
        if row.billing_30d:
            evidence.append("Recent billing contact; issue details must be verified.")
        if row.tenureMonths < 6:
            evidence.append("Short tenure: under six months.")
        if row.contractType == "Month-to-month":
            evidence.append("Month-to-month contract.")
        if not evidence:
            evidence.append("No recent support signal in the supplied extract.")
        customers.append(
            {
                "customer_id": row.customerId,
                "region": row.region,
                "risk_score": round(float(oof[i]), 6),
                "risk_band": "High"
                if oof[i] >= 0.5
                else "Medium"
                if oof[i] >= 0.2
                else "Low",
                "features": features,
                "evidence": evidence,
                "model_signals": signals[i],
                "data_quality": "Partial history",
                "history_months_at_snapshot": int(
                    (
                        (usage.customerId == row.customerId)
                        & (usage.available_at <= CUTOFF)
                    ).sum()
                ),
                "consent": "unknown",
                "eligibility": "review_required",
                "resolution_status": "unknown_at_snapshot",
                "last_contact_at": None,
                "score_method": "out_of_fold_logistic",
                "fold": int(folds[i]),
            }
        )
    intelligence = {
        "snapshot": report["snapshot"],
        "model_version": "lr-oof-v1-seed42",
        "policy_version": "retention-v1",
        "mode": "retrospective_demo",
        "customers": customers,
    }
    (out / "report.json").write_text(json.dumps(report, indent=2, allow_nan=False))
    (out / "intelligence.json").write_text(
        json.dumps(intelligence, indent=2, allow_nan=False)
    )
    frame.assign(oof_score=oof, fold=folds).to_csv(out / "cohort.csv", index=False)
    # Only anonymous aggregate results are published in the report.
    plt.rcParams.update(
        {
            "font.family": "DejaVu Sans",
            "axes.spines.top": False,
            "axes.spines.right": False,
        }
    )
    fig, ax = plt.subplots(figsize=(8, 4.3), layout="constrained")
    labels = ["Logistic", "Shallow tree", "Business rule", "Prevalence"]
    vals = [
        comparison[k]["pr_auc"]
        for k in [
            "logistic_regression",
            "shallow_tree",
            "business_rule",
            "constant_prevalence",
        ]
    ]
    bars = ax.barh(
        labels[::-1], vals[::-1], color=["#BCC7CF", "#8BA3B0", "#597D8C", "#087F73"]
    )
    ax.set_xlim(0, 1.08)
    ax.set_xlabel("Average precision (PR-AUC) · 52-customer holdout")
    for b, v in zip(bars, vals[::-1]):
        ax.text(v + 0.015, b.get_y() + b.get_height() / 2, f"{v:.3f}", va="center")
    fig.savefig(out / "model_comparison.png", dpi=180)
    plt.close(fig)
    fig, ax = plt.subplots(figsize=(8, 4.3), layout="constrained")
    ax.plot([0, 1], [0, 1], ls="--", c="#BCC7CF", label="Perfect calibration")
    ax.plot(
        [c["mean_score"] for c in calibration],
        [c["observed_rate"] for c in calibration],
        marker="o",
        c="#087F73",
        label="OOF quintiles",
    )
    ax.set(
        xlabel="Mean out-of-fold score",
        ylabel="Observed churn fraction",
        xlim=(0, 1),
        ylim=(0, 1),
    )
    ax.legend()
    fig.savefig(out / "calibration.png", dpi=180)
    plt.close(fig)
    print(
        f"Cohort: {len(frame)} customers | Holdout: {len(test)} | Average precision: {comparison['logistic_regression']['pr_auc']:.3f}\nResults saved to {out}"
    )


if __name__ == "__main__":
    main()
