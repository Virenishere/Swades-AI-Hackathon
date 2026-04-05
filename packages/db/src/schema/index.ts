import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const transcriptions = pgTable("transcriptions", {
  id: uuid("id").defaultRandom().primaryKey(),
  chunkId: text("chunk_id").notNull().unique(),
  text: text("text").notNull(),
  segments: text("segments"), // JSON.stringify of tagged Segment[]
  model: text("model").notNull(),
  language: text("language"), // e.g. "en", "hi", "fr"
  createdAt: timestamp("created_at").defaultNow(),
});
