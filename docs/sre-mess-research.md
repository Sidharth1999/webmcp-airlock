# SRE mess research — Sun 8/31 night (for scenario faithfulness + README credibility)

Purpose: ground the range's complexity ladder in documented operational reality, per Sid's
"faithful to how these are used today" bar. Each pattern below is portable into the sim's
vocabulary and citable.

## Patterns adopted NOW (cheap, ride Monday's existing scope)

1. **Gray failure / differential observability** (Huang et al.; USPTO resiliency patents cite it):
   a partial failure where some observers see healthy and others see failed — health checks
   green while users error. PORT: variant dimension on family A — `airlock_status` reports all
   services nominal while `traffic_history` shows a climbing error rate; the TELL is the
   disagreement between two read tools, which is a relationship, not a field. Strengthens the
   cross-source-synthesis bet; costs a variant, not a template.
2. **The compatibility-table rollback rule** (industry guidance, systemdesignclassroom/Harness):
   "a flag must not let v2 write values v1 can't read while v1 is still in traffic" — the
   documented general form of our flagship migration trap. PORT: cite in evidence.md; phrase the
   flagship's prose tell in these terms (writes-new-format-since-deploy count in a log line).
3. **Data abundance, not scarcity** (incident.io, Rootly, PagerDuty AI-SRE material): the real
   on-call pain is correlation across too many signals + tribal knowledge, not missing data.
   PORT: impact section language — the agent absorbs correlation load; the gate makes that safe.

## Pattern adopted as the README's course #4 (designed, not built — cite it)

4. **Metastable failures / retry storms** (HotOS '21 "Metastable Failures in Distributed
   Systems"; OSDI follow-ups; Brooker): a trigger (load spike, capacity dip) tips the system
   into a self-sustaining degraded mode — retries amplify work, which causes timeouts, which
   cause retries — and the failure PERSISTS AFTER THE TRIGGER IS GONE. Why it matters to us:
   this is the academically documented class where **every revert-shaped action fails** —
   rollback, flag-off-the-trigger, none of it works because the cause is no longer present;
   correct play is load-shedding first, then recovery. It is the strongest possible
   anti-runbook scenario family and the literature says so in our exact terms ("undoing the
   trigger does not undo the failure"). Named course #4 in the README with citation; build
   only if Monday finishes early (it needs work-amplification in the sim loop — real scope).
5. **Misleading improvement signals** (Brooker): retries LOWER day-to-day error rates while
   making the system more fragile — the metric that looks better is the trap. Future course.

## De-structuring audit (Sid's scriptability bet, Mon item)
The decisive fact in every scenario must live in PROSE or in a CROSS-TOOL RELATIONSHIP,
never in a machine-readable enum. If `reversible: false` exists as a field, the range is
scriptable and deserves to lose to the runbook arm. Audit templates Monday: migration
reversibility → deploy note prose; CVE content → changelog prose; blast radius → arithmetic
across traffic_history and list_deploys; gray-failure tell → status/traffic disagreement.

Sources: hotos '21 metastable paper + arxiv 2510.03551 formal analysis + brooker.co.za
metastability post + incident.io SRE alerting practices + Harness DB rollback guide +
systemdesignclassroom safe-rollback newsletter + Rootly/PagerDuty AI-SRE posts.
