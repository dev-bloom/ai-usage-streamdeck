/**
 * End of the +50% weekly-limit promotion: 2026-08-19 23:59 Pacific (UTC-7),
 * i.e. 2026-08-20T06:59:00Z. Hardcoded because nothing in the API reports it.
 * Once this date passes, boostNotice() returns null forever and this whole
 * file can be deleted.
 */
export const WEEKLY_BOOST_ENDS_AT = new Date("2026-08-20T06:59:00Z");

export const BOOST_NOTICE_WITHIN_DAYS = 14;

/**
 * A short reminder that the weekly cap is about to shrink back to normal, or
 * null when there is nothing to say — either because the promotion is over
 * (self-disabling: no code change needed once the date passes) or because it
 * is still far enough away that surfacing it would just be nagging.
 */
export function boostNotice(now: Date): string | null {
  const msLeft = WEEKLY_BOOST_ENDS_AT.getTime() - now.getTime();
  if (msLeft <= 0) return null;

  const hoursLeft = msLeft / (60 * 60 * 1000);
  if (hoursLeft > BOOST_NOTICE_WITHIN_DAYS * 24) return null;

  if (hoursLeft < 24) return `+50% ENDS ${Math.round(hoursLeft)}h`;
  return `+50% ENDS ${Math.round(hoursLeft / 24)}d`;
}
