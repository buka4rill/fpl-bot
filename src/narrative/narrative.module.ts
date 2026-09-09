import { Module } from '@nestjs/common';
import { NarrativeService } from './narrative.service';
import { AnthropicClient } from './clients/anthropic.client';
import { IngestionModule } from '../ingestion/ingestion.module';

// New ALERT --> NARRATIVE --> INGEST edge (ARCHITECTURE.md §2) — a
// deliberate exception to AlertModule's original "renders and sends only"
// boundary, made because every sendProposal call site already assembles
// players/snapshots itself; centralizing the narrative call here avoids
// duplicating "which players need recent form" logic across five callers.
// See CLAUDE.md's "LLM Tactical Analyst narrative layer" note (issue #8).
@Module({
  imports: [IngestionModule],
  providers: [NarrativeService, AnthropicClient],
  exports: [NarrativeService],
})
export class NarrativeModule {}
