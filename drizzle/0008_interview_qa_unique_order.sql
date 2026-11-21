-- Existing data may already hold duplicate orders (concurrent answer saves
-- raced on count+insert). Renumber each interview's rows 0..n-1, preserving
-- their current sequence, so the unique index can be created.
UPDATE "interview_qa" AS q
SET "order" = r.rn
FROM (
	SELECT "id", (ROW_NUMBER() OVER (PARTITION BY "interview_id" ORDER BY "order", "created_at", "id") - 1)::integer AS rn
	FROM "interview_qa"
) AS r
WHERE q."id" = r."id" AND q."order" <> r.rn;--> statement-breakpoint
CREATE UNIQUE INDEX "interview_qa_interview_order_key" ON "interview_qa" USING btree ("interview_id","order");
