-- Hand-written, ahead of the generated constraint below (#64).
--
-- Any row whose parent no longer exists would make ADD CONSTRAINT fail, so
-- those orphans are repaired first. Each moves to the top level AND into its
-- owner's trash: an orphan was unreachable by everyone, and putting it straight
-- back in sidebars would resurrect documents nobody has seen in a while. From
-- the trash its owner can restore it or purge it. A row already trashed keeps
-- its own deleted_at, so a restore still finds its group. Only the orphan
-- itself moves; anything beneath it keeps a parent that exists.
UPDATE "documents" AS d
   SET "parent_id" = NULL,
       "deleted_at" = coalesce(d."deleted_at", now())
 WHERE d."parent_id" IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM "documents" AS p WHERE p."id" = d."parent_id");
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_parent_id_documents_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;
