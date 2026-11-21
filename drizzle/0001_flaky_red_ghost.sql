ALTER TABLE "turns" ADD COLUMN "stt_ms" integer;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "first_token_ms" integer;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "total_llm_ms" integer;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "tts_start_ms" integer;