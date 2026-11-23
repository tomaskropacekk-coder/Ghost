import crypto from 'node:crypto';
import errors from '@tryghost/errors';
import type { Knex } from 'knex';
import { z } from 'zod';
import { toDatabaseDate } from '../../lib/db-types/date';
import { sortable } from '../../lib/sortable';
import { Segment, SegmentId } from './models';
import { filterTakenError, nameTakenError, normalizeName } from './rejections';
import type { SegmentRepository } from './repository';
import type { SegmentChangeAttempt } from './tracking';

const TABLE = 'segments';

const StoredSegment = Segment.optional();
const StoredSegments = z.array(Segment);
const CodedError = z.object({ code: z.string() });

/** Whether a write failed because a value is already taken: a segment's id or its name. */
function isUniqueViolation(err: unknown): boolean {
  const coded = CodedError.safeParse(err);
  return (
    coded.success &&
    (coded.data.code === 'ER_DUP_ENTRY' || coded.data.code.startsWith('SQLITE_CONSTRAINT'))
  );
}

/**
 * The id of a new segment: the first 24 hex characters of the SHA-256 hash of its filter. No two
 * segments are added with the same filter, so the id is the segment's own, and the table's
 * primary key rejects a second segment with a filter even when two requests add it at the same
 * time.
 */
function segmentId(filter: string): SegmentId {
  return SegmentId.parse(crypto.createHash('sha256').update(filter).digest('hex').slice(0, 24));
}

function nameTaken(attempt: SegmentChangeAttempt): never {
  attempt.rejecting('name_taken');
  throw nameTakenError();
}

function filterTaken(attempt: SegmentChangeAttempt): never {
  attempt.rejecting('filter_taken');
  throw filterTakenError();
}

function notFound(attempt: SegmentChangeAttempt): never {
  attempt.rejecting('not_found');
  throw new errors.NotFoundError({ message: 'Segment not found.' });
}

/**
 * Segments stored as rows of the segments table, in the order of the table's sortable
 * collection.
 *
 * Two rules decide whether a name is taken, and a name either rule counts as another segment's
 * is rejected. The first ignores case and surrounding whitespace, and is the same on every
 * database. The second is the table's unique index, which compares names by the database's
 * collation: MySQL's default collation also ignores accents, so it counts "Cafe" and "Café" as
 * one name.
 */
export class TableSegmentRepository implements SegmentRepository {
  private readonly rows = sortable(TABLE, 'sort_order');

  async list(executor: Knex): Promise<Segment[]> {
    return StoredSegments.parse(
      await this.rows.inOrder(executor, {}).select('id', 'name', 'filter'),
    );
  }

  async find(id: string, executor: Knex): Promise<Segment | undefined> {
    const row: unknown = await executor(TABLE).where('id', id).first('id', 'name', 'filter');
    return StoredSegment.parse(row);
  }

  async findForUpdate(id: string, trx: Knex.Transaction): Promise<Segment | undefined> {
    const row: unknown = await trx(TABLE).where('id', id).forUpdate().first('id', 'name', 'filter');
    return StoredSegment.parse(row);
  }

  async insert(
    input: Omit<Segment, 'id'>,
    trx: Knex.Transaction,
    attempt: SegmentChangeAttempt,
  ): Promise<Segment> {
    const stored = await this.list(trx);
    if (stored.some(({ name }) => normalizeName(name) === normalizeName(input.name))) {
      nameTaken(attempt);
    }
    if (stored.some(({ filter }) => filter === input.filter)) {
      filterTaken(attempt);
    }

    const segment = { id: segmentId(input.filter), name: input.name, filter: input.filter };
    try {
      await trx(TABLE).insert({ ...segment, created_at: toDatabaseDate(new Date()) });
    } catch (err) {
      if (!isUniqueViolation(err)) {
        throw err;
      }
      // The table rejected the row although no stored segment had its name or filter above:
      // another request added a segment at the same time, or the database's collation counts
      // the name as another segment's. A locking read sees a row committed in the meantime, and
      // a shared lock is all it needs: an exclusive one would deadlock two requests that were
      // both rejected over the same row.
      const sameFilter: unknown = await trx(TABLE).where('id', segment.id).forShare().first('id');
      if (sameFilter) {
        filterTaken(attempt);
      }
      nameTaken(attempt);
    }
    await this.rows.append(trx, {}, segment.id);
    return segment;
  }

  async update(
    segment: Segment,
    trx: Knex.Transaction,
    attempt: SegmentChangeAttempt,
  ): Promise<Segment> {
    const others = (await this.list(trx)).filter(({ id }) => id !== segment.id);
    if (others.some(({ name }) => normalizeName(name) === normalizeName(segment.name))) {
      nameTaken(attempt);
    }

    let updated: number;
    try {
      // A segment's filter can't change, so only the name can differ from what's stored.
      updated = await trx(TABLE)
        .where('id', segment.id)
        .update({ name: segment.name, updated_at: toDatabaseDate(new Date()) });
    } catch (err) {
      if (isUniqueViolation(err)) {
        nameTaken(attempt);
      }
      throw err;
    }
    if (updated === 0) {
      notFound(attempt);
    }
    return segment;
  }

  async delete(
    segment: Segment,
    trx: Knex.Transaction,
    attempt: SegmentChangeAttempt,
  ): Promise<void> {
    const deleted = await trx(TABLE).where('id', segment.id).del();
    if (deleted === 0) {
      notFound(attempt);
    }
  }
}
