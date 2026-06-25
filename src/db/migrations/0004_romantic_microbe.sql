CREATE TABLE "user_session_access" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "assigned_to_user_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sent_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "has_all_sessions_access" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_session_access" ADD CONSTRAINT "user_session_access_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_session_access" ADD CONSTRAINT "user_session_access_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_user_session_access_user_session" ON "user_session_access" USING btree ("user_id","session_id");--> statement-breakpoint
CREATE INDEX "idx_user_session_access_user_id" ON "user_session_access" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_assigned_to_user_id_users_id_fk" FOREIGN KEY ("assigned_to_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sent_by_user_id_users_id_fk" FOREIGN KEY ("sent_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;