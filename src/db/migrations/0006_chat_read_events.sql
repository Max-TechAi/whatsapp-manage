CREATE TYPE "public"."chat_read_trigger" AS ENUM('manual', 'reply');--> statement-breakpoint
CREATE TABLE "chat_read_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"chat_id" uuid NOT NULL,
	"user_id" uuid,
	"trigger" "chat_read_trigger" NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "chat_read_events" ADD CONSTRAINT "chat_read_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_read_events" ADD CONSTRAINT "chat_read_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_read_events" ADD CONSTRAINT "chat_read_events_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_read_events" ADD CONSTRAINT "chat_read_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_chat_read_events_org_created" ON "chat_read_events" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_chat_read_events_chat_id" ON "chat_read_events" USING btree ("chat_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_chat_read_events_user_id" ON "chat_read_events" USING btree ("user_id");
