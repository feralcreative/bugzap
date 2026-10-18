// EXCERPT of Routeloop's src/db/schema.ts at f46ca5a: the feedback enums, tables, and row types only.
// Not compilable on its own: the imports and the users table live in the full schema.

// What a rider is telling us. The fork is the first screen of the intake and it
// is the only classification they are asked for; everything else about a report
// is inferred or optional.
export const feedbackKindEnum = pgEnum('feedback_kind', ['bug', 'idea', 'question'])
// The OWNER'S GATE, and what makes a bug private without a private-bug feature:
// nothing is visible to anyone but its author and the owner until it is
// 'published'. Deliberately separate from feedback_status — a bug is routinely
// 'fixed' while still 'pending' and there is nothing contradictory about that.
export const feedbackStateEnum = pgEnum('feedback_state', ['pending', 'published', 'declined', 'duplicate', 'spam'])
// The RIDER-FACING lifecycle, orthogonal to the gate above. Every member has a label
// and a sub-line in STATUS_META, and test/feedback-status-labels.test.ts fails the
// build if one is added here without copy — a raw enum value rendered to a rider is
// the failure mode.
export const feedbackStatusEnum = pgEnum('feedback_status', [
  'new',
  'needs_info',
  'confirmed',
  'planned',
  'in_progress',
  'shipped',
  'on_list',
  'not_doing',
  'no_repro',
  'by_design',
])

// One submission of any kind — a bug, an idea or a question. The word is "report":
// never "ticket", never "issue", never "post". See docs/rider-feedback.md.
//
// state and status are two columns on purpose; the enums above say why.
//
// The audience shapes the columns. Riders are motorcyclists on phones, often
// outdoors, who will not write reproduction steps and will abandon a form that asks
// — so `body` is the only required field, `title` is DERIVED from it, and every
// other text column is optional.
//
// priority is owner-only and must NEVER reach a rider-facing surface.
export const feedback = pgTable(
  'feedback',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    // Unguessable, same generator as rides.slug. The board, the rider's own
    // view and every email address a report by this and never by id.
    publicId: varchar('public_id', { length: 22 }).notNull(),
    authorId: bigint('author_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: feedbackKindEnum('kind').notNull(),
    state: feedbackStateEnum('state').notNull().default('pending'),
    status: feedbackStatusEnum('status').notNull().default('new'),
    // Derived from the first line of body at submit time and editable by the
    // owner before publishing. Riders are not asked for a title.
    title: varchar('title', { length: 150 }),
    body: varchar('body', { length: 4000 }).notNull(), // the one required field
    context: varchar('context', { length: 2000 }), // "when did you last wish you had it"—ideas only
    // Which screen, from the chip group. Nullable because the floating entry
    // point pre-fills it from ?area= and the rider is never asked twice.
    area: varchar('area', { length: 40 }),
    frequency: varchar('frequency', { length: 20 }), // every_time/sometimes/once/unknown—bugs only
    impact: varchar('impact', { length: 20 }), // nice/often/every_ride—ideas only
    // Denormalized, written in the same transaction as the vote rows. Reading a
    // count(*) per row on every board render is the thing this avoids.
    wantCount: integer('want_count').notNull().default(0),
    priority: smallint('priority'), // owner-only, never rendered publicly
    ownerNote: varchar('owner_note', { length: 2000 }), // private scratchpad
    publicResponse: varchar('public_response', { length: 2000 }), // shown on the board when published
    duplicateOf: bigint('duplicate_of', { mode: 'number' }).references((): AnyPgColumn => feedback.id),
    replyOk: boolean('reply_ok').notNull().default(true), // rider consented to a follow-up
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    publishedAt: timestamp('published_at'),
  },
  (t) => [
    uniqueIndex('uq_feedback_public_id').on(t.publicId),
    index('idx_feedback_board').on(t.state, t.kind, t.wantCount),
    index('idx_feedback_queue').on(t.state, t.createdAt),
    index('idx_feedback_author').on(t.authorId),
  ],
)

// One rider wanting one report. The composite primary key IS the anti-fraud
// mechanism — one want per rider per report, enforced by Postgres rather than by
// a check in the handler that a second code path could forget.
export const feedbackVotes = pgTable(
  'feedback_votes',
  {
    feedbackId: bigint('feedback_id', { mode: 'number' })
      .notNull()
      .references(() => feedback.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.feedbackId, t.userId] }), index('idx_feedback_vote_user').on(t.userId)],
)

// What the browser was doing, captured silently so no rider is ever asked a
// technical question. Its own table rather than a column on feedback because the
// blob runs 5–50 KB and every board query would drag it across the wire.
//
// $type<> is a compile-time claim Postgres does not enforce: every read goes
// through parseDiagnostics(), which is lenient by design and never casts.
//
// NOTHING REACHES THIS COLUMN UNREDACTED. src/feedback/diagnostics.ts strips query
// strings and fragments from every URL, and geolocation is recorded as a permission
// state, never a position.
export const feedbackDiagnostics = pgTable('feedback_diagnostics', {
  feedbackId: bigint('feedback_id', { mode: 'number' })
    .primaryKey()
    .references(() => feedback.id, { onDelete: 'cascade' }),
  payload: jsonb('payload')
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

// A screenshot or photo a rider attached, on disk under STORAGE_PATH following
// the src/maps/storage.ts convention.
//
// These bytes are counted HERE and nowhere else. They must stay out of
// rides.size_bytes and out of users.used_bytes: they are not ride data, they
// must not eat a rider's quota, and adding a fourth byte column to that
// generated expression would corrupt quota accounting on every ride delete.
export const feedbackAttachments = pgTable(
  'feedback_attachments',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    feedbackId: bigint('feedback_id', { mode: 'number' })
      .notNull()
      .references(() => feedback.id, { onDelete: 'cascade' }),
    storageKey: varchar('storage_key', { length: 255 }).notNull(),
    mime: varchar('mime', { length: 60 }).notNull(),
    bytes: integer('bytes').notNull().default(0),
    width: integer('width'),
    height: integer('height'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [index('idx_feedback_attachment').on(t.feedbackId)],
)

export type FeedbackRow = typeof feedback.$inferSelect
export type FeedbackVoteRow = typeof feedbackVotes.$inferSelect
export type FeedbackDiagnosticsRow = typeof feedbackDiagnostics.$inferSelect
export type FeedbackAttachmentRow = typeof feedbackAttachments.$inferSelect
/** The three things a rider can send, derived from the enum so the two cannot drift. */
export type FeedbackKind = (typeof feedbackKindEnum.enumValues)[number]
/** The owner's visibility gate, derived from the enum so the two cannot drift. */
export type FeedbackState = (typeof feedbackStateEnum.enumValues)[number]
/** The rider-facing lifecycle, derived from the enum so the two cannot drift. */
export type FeedbackStatus = (typeof feedbackStatusEnum.enumValues)[number]
