'use strict';
// What a plan actually permits, and the one place that decides it.
//
// These limits existed before but were only ever *displayed* on the settings
// page — nothing consulted them, so a Free church could add unlimited users and
// run every report. That made the two tiers identical in practice, which meant
// there was no reason for anyone to move to Pro.
//
// Enforcement is deliberately at the point of creation, never retroactive: a
// church that is already over a limit keeps everything it has and is stopped
// from adding more. Downgrading must not silently delete someone's staff
// accounts, and an expired Pro subscription must not lock people out of data
// they entered.

const PLAN_LIMITS = {
  free: { label: 'Free', maxUsers: 2, reports: false },
  pro: { label: 'Pro', maxUsers: null, reports: true },
};

// Pro with no proUntil means "no expiry"; Pro with a past proUntil has lapsed
// back to Free. Anything else is Free.
function isPro(church) {
  if (!church || church.plan !== 'pro') return false;
  return !church.proUntil || new Date(church.proUntil) > new Date();
}

function planFor(church) {
  return PLAN_LIMITS[isPro(church) ? 'pro' : 'free'];
}

// null maxUsers means unlimited. `activeUsers` should exclude soft-deleted
// accounts, matching what the settings page counts.
function canAddUser(church, activeUsers) {
  const { maxUsers } = planFor(church);
  if (maxUsers === null) return true;
  return activeUsers < maxUsers;
}

function canUseReports(church) {
  return planFor(church).reports;
}

// One message, so the wording is identical wherever a limit is hit.
function upgradeMessage(reason) {
  if (reason === 'users') {
    const { maxUsers } = PLAN_LIMITS.free;
    return `The Free plan includes ${maxUsers} staff accounts. Upgrade to Pro to add more.`;
  }
  return 'Reports are part of the Pro plan.';
}

module.exports = { PLAN_LIMITS, isPro, planFor, canAddUser, canUseReports, upgradeMessage };
