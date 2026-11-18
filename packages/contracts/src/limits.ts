/**
 * Product safety limits from the system design (§§7, 8, 11, 12). They are service limits, not
 * AWS maxima. Model affordability is checked separately at admission and can reject input that
 * fits these limits (`budget_exceeded_preflight`).
 */
export const LIMITS = {
  /** Largest upload accepted by POST /documents. */
  uploadBytes: 10 * 1024 * 1024,
  /** PDF pages read by deterministic extraction. */
  pdfPages: 30,
  /** PDF pages that may need OCR before the job is rejected with `ocr_page_limit`. */
  ocrPages: 3,
  /** Submitted or extracted resume text. */
  sourceTextChars: 100_000,
  /** Pasted job description. */
  jobDescriptionChars: 5_000,
  /** Questions in one generated set. */
  questionsPerSet: 5,
  /** Questions issued across every round of one session. */
  questionsPerSession: 10,
  /** Question rounds per session: the first round plus one refinement. */
  questionRoundsPerSession: 2,
  /** One answer value. */
  answerChars: 2_000,
  /** Uploads waiting for completion per user. */
  pendingUploadsPerUser: 10,
  /** Jobs queued or running per user. */
  activeJobsPerUser: 2,
  /** Jobs admitted per user per UTC day. */
  jobsPerUserPerDay: 20,
  /** A job ends `expired` this long after admission, including retries. */
  jobDeadlineMs: 10 * 60 * 1000,
  /** Idempotency-Key and clientRequestId length bounds. */
  idempotencyKeyMinChars: 8,
  idempotencyKeyMaxChars: 128,
  /** Entries per career section and bullets per entry. */
  entriesPerSection: 50,
  bulletsPerEntry: 30,
  /** One short text field (names, titles) and one long text field (details, bullets). */
  shortTextChars: 300,
  longTextChars: 5_000,
} as const;

export type Limits = typeof LIMITS;
