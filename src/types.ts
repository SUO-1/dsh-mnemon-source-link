// Shared federated Source types for dsh-mnemon-source-link.
// These signatures are the public contract referenced by every later task:
// do not rename fields or add/remove members here without updating the plan.

export type LinkSourceId = 'obsidian' | 'loginote' | 'ledger';
export type LinkItemType = 'note' | 'task' | 'ledger';
export interface LinkObservation { category: string; text: string }
export interface LinkRelation { type: string; target: string }
export interface LinkProvenance { path: string; line?: number; kind?: string }
export interface LinkItem {
  id: string;                 // 'obsidian:<relPath>' | 'loginote:<relPath>' | 'ledger:<relPath>#L<line>'
  source: LinkSourceId; type: LinkItemType;
  title: string; body: string;
  observations: LinkObservation[]; relations: LinkRelation[];
  tags: string[]; ts: string;                 // ts = ISO
  provenance: LinkProvenance; truncated?: boolean;
}
export interface AdapterFacts { reachable: boolean; count: number; revision: string }
export interface ScanLimits { maxFiles: number; maxFileBytes: number; maxResults: number; maxCharacters: number }
export interface LinkAdapter {
  readonly id: LinkSourceId;
  readonly label: { zh: string; en: string };
  facts(): Promise<AdapterFacts>;
  search(q: string, limits: ScanLimits): Promise<LinkItem[]>;
  read(id: string): Promise<LinkItem | undefined>;
  list(limits: ScanLimits): Promise<LinkItem[]>;
  graph(id: string): Promise<LinkRelation[]>;
  dispose?(): void;
}
