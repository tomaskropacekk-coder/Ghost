import type { Knex } from 'knex';
import { z } from 'zod';
import segments from '../../../../services/segments';
import { MAX_NAME_LENGTH, SegmentFilter, SegmentName } from '../../../../services/segments/models';
import {
  isFilterTakenError,
  isNameTakenError,
  normalizeName,
} from '../../../../services/segments/rejections';

// Imports a site's segments, which Admin shows as saved member views.
//
// An export holds them in one of two places. An export from a version that stores segments in a
// table of their own has them as rows under `segments`. An older export has them as entries of
// the `shared_views` setting, beside the posts list's saved views. Both are added through the
// segments service, so an imported segment follows the rules any new segment does.

/** A segment in an export file. */
interface ExportedSegment {
  name: string;
  filter: string;
}

/** A row of the segments table in an export. Rows are imported in their order. */
const ExportedRow = z.object({
  name: z.string(),
  filter: z.string(),
  sort_order: z.number().catch(0),
});

/**
 * A saved member view as an older export holds it in the `shared_views` setting: a view of the
 * members list with a name and a filter.
 */
const SavedMemberView = z.object({
  name: z.string(),
  route: z.literal('members'),
  filter: z.object({ filter: z.string().min(1) }),
});

const SavedViews = z.array(z.unknown());

const ExportedSetting = z.object({ key: z.string(), value: z.unknown() });

const ExportData = z.object({
  segments: z.array(z.unknown()).catch([]),
  settings: z.array(z.unknown()).catch([]),
});

/** The entries of a `shared_views` value, or null when the value isn't a list of entries. */
function savedViews(value: unknown): unknown[] | null {
  if (typeof value !== 'string') {
    return null;
  }
  try {
    const parsed = SavedViews.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * A `shared_views` value without its saved member views, which are imported as segments. A
 * value that isn't a list of entries is returned as it is.
 */
export function withoutSavedMemberViews(value: unknown): unknown {
  const entries = savedViews(value);
  if (!entries) {
    return value;
  }
  return JSON.stringify(entries.filter((entry) => !SavedMemberView.safeParse(entry).success));
}

/** The segments in an export file's data, in their order: its rows, then its saved member views. */
function exportedSegments(allDataFromFile: unknown): ExportedSegment[] {
  const data = ExportData.safeParse(allDataFromFile);
  if (!data.success) {
    return [];
  }
  const rows = data.data.segments
    .flatMap((row) => ExportedRow.safeParse(row).data ?? [])
    .sort((a, b) => a.sort_order - b.sort_order);
  const views = data.data.settings
    .flatMap((setting) => ExportedSetting.safeParse(setting).data ?? [])
    .filter(({ key }) => key === 'shared_views')
    .flatMap(({ value }) => savedViews(value) ?? [])
    .flatMap((entry) => SavedMemberView.safeParse(entry).data ?? [])
    .map(({ name, filter }) => ({ name, filter: filter.filter }));
  return [...rows, ...views];
}

/**
 * The name a segment is imported under: `name` itself for the number 1, and otherwise `name` with
 * the number added, such as "VIP (2)". Either is cut to be no longer than a segment's name can be.
 */
function numbered(name: string, number: number): string {
  const suffix = number === 1 ? '' : ` (${number})`;
  return [...name.trim()].slice(0, MAX_NAME_LENGTH - suffix.length).join('') + suffix;
}

interface ImportProblem {
  message: string;
  help: string;
  context: string;
}

/**
 * The step of a data import that adds the file's segments. It has the shape the data importer
 * drives every step through.
 */
export class SegmentsImporter {
  readonly dataKeyToImport = 'segments';
  readonly options = { requiredImportedData: [], requiredExistingData: [] };
  readonly requiredImportedData = {};
  readonly requiredExistingData = {};
  readonly problems: ImportProblem[] = [];
  readonly errors: unknown[] = [];
  readonly importedData: ExportedSegment[] = [];
  readonly importedDataToReturn: ExportedSegment[] = [];

  private readonly toImport: ExportedSegment[];

  constructor(allDataFromFile: unknown) {
    this.toImport = exportedSegments(allDataFromFile);
  }

  async fetchExisting(): Promise<void> {}

  async beforeImport(): Promise<void> {}

  async replaceIdentifiers(): Promise<void> {}

  /**
   * Adds each segment in the file, in the file's order and in the import's transaction.
   *
   * A segment whose filter the site already has is not added again. A segment that can't be
   * one, such as one with an empty name, is left out. A segment whose name is taken by a segment
   * with another filter is added with a number, such as "VIP (2)", because nobody can be asked
   * for another name during an import. Every segment whose own name is free keeps it, so a
   * segment only gets a number when the site, or an earlier segment in the file, has its name.
   */
  async doImport({ transacting }: { transacting: Knex.Transaction }): Promise<void> {
    if (this.toImport.length === 0) {
      return;
    }
    const { service } = segments;
    const stored = await service.browse(transacting);
    const filters = new Set(stored.map(({ filter }) => filter));
    const taken = new Set(stored.map(({ name }) => normalizeName(name)));

    const wanted: { segment: ExportedSegment; filter: SegmentFilter; number?: number }[] = [];
    for (const segment of this.toImport) {
      const filter = SegmentFilter.safeParse(segment.filter);
      if (!filter.success || !SegmentName.safeParse(numbered(segment.name, 1)).success) {
        this.skipped(segment, 'Segment was not imported because its name or filter is invalid.');
      } else if (filters.has(filter.data)) {
        this.skipped(segment, 'Segment was not imported because the site already has its filter.');
      } else {
        filters.add(filter.data);
        wanted.push({ segment, filter: filter.data });
      }
    }

    /** The first number from `from` that gives `name` a name nothing has taken, which it takes. */
    const take = (name: string, from: number): number => {
      let number = from;
      while (taken.has(normalizeName(numbered(name, number)))) {
        number += 1;
      }
      taken.add(normalizeName(numbered(name, number)));
      return number;
    };
    for (const entry of wanted) {
      if (!taken.has(normalizeName(numbered(entry.segment.name, 1)))) {
        entry.number = take(entry.segment.name, 1);
      }
    }
    for (const entry of wanted) {
      entry.number ??= take(entry.segment.name, 2);
    }

    // Each rejected name leads to one the service has free, and the database can only count
    // it as taken by a segment that is stored, so one more try than there are segments is enough.
    const tries = stored.length + wanted.length + 1;
    for (const { segment, filter, number } of wanted) {
      await this.add(segment, filter, { number: number ?? 1, tries, take }, transacting);
    }
  }

  /**
   * Adds `segment` under its name with `names.number`. The service compares names as `take`
   * does, but the database can count a name as another segment's where that comparison
   * doesn't, as MySQL's default collation does for "Cafe" and "Café". The segment is then tried
   * with the next free number, up to `names.tries` times. A rejected add has written nothing, so
   * the import goes on.
   */
  private async add(
    segment: ExportedSegment,
    filter: SegmentFilter,
    names: { number: number; tries: number; take: (name: string, from: number) => number },
    transacting: Knex.Transaction,
  ): Promise<void> {
    let { number } = names;
    for (let tried = 0; tried < names.tries; tried += 1) {
      const name = SegmentName.parse(numbered(segment.name, number));
      try {
        const added = await segments.service.add({ actor: null }, { name, filter }, transacting);
        this.importedData.push(added);
        this.importedDataToReturn.push(added);
        return;
      } catch (err) {
        if (isFilterTakenError(err)) {
          break;
        }
        if (!isNameTakenError(err)) {
          throw err;
        }
        number = names.take(segment.name, number + 1);
      }
    }
    this.skipped(segment, 'Segment was not imported because the site already has it.');
  }

  private skipped(segment: ExportedSegment, message: string): void {
    this.problems.push({ message, help: 'Segment', context: JSON.stringify(segment) });
  }
}
