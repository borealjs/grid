import type { Messages } from './types.js';

const n = (x: number) => x.toLocaleString();

/** Texts the grid shows; pass `messages` to translate or reword any of them. */
export const DEFAULT_MESSAGES: Messages = {
  noRows: 'No rows match the filter',
  noData: 'No rows',
  filterTitle: (name) => `Filter: ${name}`,
  min: 'Min',
  max: 'Max',
  from: 'From',
  to: 'To',
  contains: 'Contains',
  containsPlaceholder: 'Text to look for',
  find: 'Find',
  searchValues: (total) => (total === undefined ? 'Search values' : `Search ${n(total)} values`),
  all: 'All',
  none: 'None',
  loadingValues: 'Loading values…',
  noValues: 'No values match',
  refineSearch: (shown, matches) => `Showing the first ${n(shown)} of ${n(matches)} — refine the search to see more`,
  valuesFailed: (reason) => `Could not load values: ${reason}`,
  clear: 'Clear',
  apply: 'Apply',
  selectAll: 'Select all',
  selectRow: 'Select row',
  selectAllRows: 'Select all rows',
  columns: 'Columns',
  applying: 'Applying…',
  cancel: 'Cancel',
  // A sort or filter that takes a while; progress ({ phase, done, total }) comes from the data source.
  working: (what, progress, seconds) => {
    const verb = what === 'sort' ? 'Sorting' : what === 'columns' ? 'Updating columns' : 'Filtering';
    const parts: string[] = [];
    if (progress?.phase) parts.push(progress.phase);
    if (progress?.total && progress.total > 0) parts.push(`${Math.min(99, Math.floor((100 * (progress.done ?? 0)) / progress.total))}%`);
    if (seconds >= 1) parts.push(`${Math.round(seconds)} s`);
    return parts.length ? `${verb}… ${parts.join(' · ')}` : `${verb}…`;
  },
  filterLimit: (limit, total) => `Filtering is turned off for this table. Its server filters up to ${n(limit)} rows, and this table has ${n(total)}.`,
  sortLimit: (limit, total) => `Sorting by more than one column is turned off for this table. Its server sorts that way up to ${n(limit)} rows, and this table has ${n(total)}.`,
  failed: (what, reason) => `${what === 'sort' ? 'Sorting' : 'Filtering'} failed: ${reason}`,
  copying: (cells) => `Copying ${n(cells)} cells…`,
  copied: (info) => {
    const size = info.ranges > 1
      ? `${n(info.cells)} cells from ${info.ranges} ranges`
      : `${n(info.rows)} × ${n(info.cols)} (${n(info.cells)} ${info.cells === 1 ? 'cell' : 'cells'})`;
    return `Copied ${size}${info.plainOnly ? ' as text' : ''}`;
  },
  copyTooLarge: (cells, limit) => `Selection too large to copy: ${n(cells)} cells (limit ${n(limit)})`,
  copyRefused: 'The browser refused clipboard access',
  copyLoadFailed: (reason) => `Could not load the cells: ${reason}`,
  copyAgain: (loaded, shortcut) => `Loaded ${n(loaded)} cells; press ${shortcut} again to copy`,
};
