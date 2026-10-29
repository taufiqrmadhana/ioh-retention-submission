// What the assistant knows about the workbench UI: pages, panels and how to
// read them. Panel titles must match the headings in web/app.js so the chat
// can link to them.

export const PAGES = {
  overview: "Overview",
  customers: "Customer explorer",
  agent: "Agent workspace",
  evidence: "Evidence & model",
};

export const SITE_GUIDE = `Layout: a left sidebar with the four pages (Overview, Customer explorer, Agent workspace, Evidence & model) and a "Model & policy" card (logistic model with 5-fold out-of-fold scores, policy retention-v2, execution = simulation only). The top bar shows the page name and the decision date, 01 Nov 2025. Overview, Customer explorer and Agent workspace start with a pink "Retrospective simulation" banner: scores are historical estimates and nothing is sent to customers. The chat assistant is the floating face in a bottom corner; it can be dragged to either side.

Risk bands: High = OOF score at least 50%, Medium = 20% to 50%, Low = under 20% (40 High, 13 Medium, 155 Low). The OOF (out-of-fold) score is the model's churn estimate for a customer from a model that never saw that customer in training.

Review route (Overview and Customer explorer tables): "Technical review" if the customer had a technical support contact in the 30 days before 1 Nov and their risk clears the offer break-even (12.5% at default assumptions); "Billing review" if a billing contact and no technical one, with the same risk floor; "Observe · below break-even" for a recent contact under that floor; "Compare incentives" if an offer has positive scenario net benefit under the current assumptions; otherwise "Observe".

PAGE overview — Overview (#overview). Starting point.
- Buttons top right: "Model evaluation" opens Evidence & model; "Create proposal" opens Agent workspace.
- Four cards: "Customers in cohort" (208 customers with an October usage row and no churn before 1 Nov; this is the observable cohort, not the whole active base, see Evidence & model); "Score ≥ 50%" (40 customers above an exploratory threshold, not an eligibility rule); "Recent service / billing contacts" (28 customers with a contact in the prior 30 days, resolution unknown); "Campaign budget" (the current budget and customer capacity from Agent workspace settings).
- "Customer review queue": the 10 highest-risk customers with region, risk bar, contract and review route. Click an ID or "Inspect" for the customer detail. "All 208 customers" opens Customer explorer.
- "Policy allocation preview": a live, unsaved run of the policy with the current settings: total spend, customers selected, how many get each action, unallocated budget.
- "Score distribution": how many customers fall in each 20-point score bucket. Scores are polarised: most customers are near 0% and a group is near 100%.

PAGE customers — Customer explorer (#customers). All 208 customers, highest risk first, 12 per page.
- Search by customer ID or region; filter by risk band; arrows at the bottom page through results.
- Columns: Customer, Region, Risk estimate (bar and %), Band, Contract, Review route, Inspect.

Customer detail (pop-up, opens from any customer ID or "Inspect" anywhere):
- Header: region, contract, months of usage history observed before 1 Nov.
- Tiles: OOF risk estimate, tenure in months, monthly charge.
- "Observed evidence": plain facts behind the score, such as short tenure or a month-to-month contract. "Unknown at decision time": consent, live status, contact limits, eligibility, resolution status.
- "Model contributions": signed log-odds per input. Positive pushes the score up, negative pulls it down; bigger magnitude = bigger effect. They explain the score, not the cause of churn.
- "Action comparison": each action's cost, scenario net benefit (risk × success rate × retained value − cost; "Unmeasured" for reviews) and status: "Review required" = allowed in a proposal, "Not eligible" = blocked (offers are blocked when there was a recent service or billing contact; reviews are blocked when risk is below the offer break-even).

PAGE agent — Agent workspace (#agent). Where proposals are made, reviewed and approved.
- "Campaign settings" (left): budget slider Rp0–10M, maximum customers 1–20, "Prioritize technical reviews over billing reviews", and "Economic assumptions" (retained customer value, basic and premium prevention %). "Generate policy plan" runs the deterministic policy over all 208 customers and saves the result as a proposal.
- "Retention planning request": a prompt box for the LLM agent; the two suggestion buttons fill in example prompts; "Run agent" starts it. The agent turns the request into a scope (contact type: all, technical, billing or no contact; and a region); the backend then plans over every customer in that scope with the same policy, so the agent never hand-picks customers. It reads candidates and compares actions to explain the result, then submits the plan, through five bounded tools. Budget and capacity always come from the settings panel. It is disabled when no AI key is configured and limited to 5 runs per 10 minutes.
- Proposal card (appears below): "Policy proposal" or "Agent proposal", status badge (pending review, simulated approved, rejected), the agent's rationale, tiles for proposed spend, scenario net benefit and customers used, and a table of customer, action, cost and assumed net benefit. "candidates not selected" lists who was skipped and why. "Agent tool trace" shows every tool call with inputs and results.
- Review: tick the checklist box, then "Approve simulation" or "Reject proposal". Approval only records a simulation; nobody is contacted. After approval, "Record a simulated outcome" stores a synthetic retained/churned/no-response result that is excluded from training. "Download proposal JSON" exports the plan.
- "Session history": plans saved in this browser session (up to 50, kept 7 days). Click a plan ID to reopen it; "Refresh" reloads the list.

PAGE evidence — Evidence & model (#evidence). How the model was built and how far to trust it.
- Four cards: source customers (720), decision cohort (208 with October usage, 41 churned in November), holdout average precision (PR-AUC 0.967 with bootstrap interval) and holdout lift in the top 20% (4.25×: the top fifth holds 4.25 times the average churn rate).
- "Point-in-time cohort definition": the five steps that prevent leakage (features before 1 Nov only, resolution status excluded, label = churn in November, train/holdout split inside one cohort, OOF scores for the demo), then "Who is in the cohort": 616 customers had not churned by 1 Nov but 408 have no October usage row and are excluded; every November churner has that row, so 19.7% is the churn rate of the observable cohort, not of all active customers.
- "Data quality findings": counts of data issues, such as customers with one usage row or blank total charges.
- "Holdout model comparison": bars of average precision (PR-AUC) on the 52-customer holdout for logistic regression (highlighted), the shallow tree, the business rule and the prevalence baseline (about 0.19, what random ranking gets). Longer bar = better ranking of churners; whiskers are 95% bootstrap intervals.
- "Calibration and probability error": each dot is a fifth of customers; x = average predicted risk, y = share that actually churned; the dashed diagonal is perfect calibration. Dots below it mean the model over-predicts, above it under-predicts. The top fifth predicted about 79% and observed 95%. Ranking is strong; the probabilities are not calibrated. The Brier score below is probability error (lower is better). A sigmoid-calibration test (fitted on training rows only) made Brier and log-loss worse and barely changed the plan, so the raw scores are kept.
- "Break-even sensitivity": x = multiplier on the assumed success rates (1× = 20% basic, 50% premium), y = plan net benefit in Rp millions, one line per retained value. The dashed line is the break-even multiplier (see the project facts for the value), found by re-planning at each step: below it the plan loses money.
- "Net benefit versus threshold": a decision curve. For each threshold, the model line shows net benefit per customer from acting on everyone above it, compared with "treat all" and "treat none" (zero). Where the model line is highest, acting on the score adds value.
- "Observation coverage is not uniform": active customers and next-month churn per monthly snapshot. Early snapshots are almost all churners and December has no outcomes yet, which is why there is no out-of-time test.
- "Strategies at the same budget and eligibility": the policy plan against premium-only and basic-only to the highest risk, all with the same budget, capacity and service/billing checks, plus what an uncapped threshold rule would do with and without those checks.
- "Economic decision contract": the net benefit formula, the 30% service-review reservation, the algorithm gap (greedy versus an exact optimiser that keeps the same reviews) and, separately, the scenario value the review reservation gives up, and the targeting check.
- "Limitations", "What the agent can do", "Experiment and monitoring plan" (randomised control test, what to monitor, retraining rules).
- "Subgroup audit · exploratory": churn rate, mean score, and how many customers each group has in the cohort-wide top 20% with the resulting recall, by gender and region. Recall uses one shared cutoff; a per-group quota would cap Bandung (12 slots for 25 churners). Gender and age are not model inputs; groups are small, so this is not a fairness certificate.

Common tasks:
- See the riskiest customers: Overview queue, or Customer explorer with the High filter.
- Understand one customer: click the ID, read evidence, contributions, then action comparison.
- Make and approve a plan: Agent workspace → set budget and capacity → "Generate policy plan" (or write a prompt and "Run agent") → read the proposal and skipped list → tick the checklist → "Approve simulation".
- Try a budget quickly: ask the assistant for a simulation, then press "Open in agent workspace" on the result card to load those settings.
- Judge the model: Evidence & model → model comparison, calibration, then limitations.`;
