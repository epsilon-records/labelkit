# Re-run request budget

Issue: epsilon-records/labelkit#166. Reviewed 17 November 2026.

The historical six-second path is already changed by PR #102. `actions.runAnalysis` does not submit audio or call R2. It validates the request, obtains any plan limits, and commits the queued job plus audit row in one RLS transaction. The existing scheduled worker submits the actual analysis. The UI already exposes starting and pending states.

With plans disabled or an exempt organisation, the database path is four measured exchanges: BEGIN, transaction-local role/user, the job-and-audit statement, COMMIT. `run-analysis-round-trips.test.ts` now delays each client write by 98 ms (the observed Ohio–Frankfurt RTT recorded in decision 0029) and requires the actual action to finish below one second. It verifies the committed job and audit after the timed response. This runs against real Supabase in CI, not a fake database. The existing plan-enabled six-exchange and rollback tests remain.

This is an action budget on a connected pool. It excludes framework cold startup, the preceding Auth/membership hook, browser transfer and post-action page-data invalidation. The existing 340 ms Auth observation plus four 98 ms exchanges estimates about 732 ms before other overhead; that is an estimate, not a production observation. Cold startup is separately budgeted by PR #220.

## Healthy plans and the retained outage policy

For non-exempt organisations with plans enabled, the action awaits `limitsFor()` before the RLS transaction. `LabelPlansBilling` permits up to 5000 ms for its request and fails open if billing is unreachable. Healthy plan checks add the lookup and two exchanges for the limit lock/count; a stalled lookup alone can exceed the one-second target.

Changing that timeout would apply fail-open earlier; caching would permit stale limits. Both change billing behaviour. This PR changes neither. The Oracle chose the healthy/plans-disabled budget on 17 November (knowledge#197); the billing-outage path is explicitly outside it because retaining the existing 5000 ms fail-open policy was required. A second test exercises the actual plan-enabled action with an 80 ms healthy billing response and six 98 ms exchanges, again below one second. No background acceptance is added before permission, plan and durable queue checks finish.

Production's current `PLANS_ENABLED` value and a signed-in live Re-run have not been read or exercised here. No production jobs or catalogue changes were created. After deployment the Oracle should time the actual first form response separately from page invalidation and record whether plans were active.
