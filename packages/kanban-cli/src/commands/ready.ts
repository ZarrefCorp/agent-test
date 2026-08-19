import { GitHubClient, requireToken } from '../graphql/client.js';
import { LIST_ITEMS_IN_STATUS } from '../graphql/queries.js';
import { findProjectByOwner } from '../graphql/find-project.js';
import { emitJSON, emitTable, pickFormat } from '../output.js';
import type { ParsedArgs } from '../cli.js';

interface ListItemsData {
  node: {
    items: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: ListItemNode[];
    };
  } | null;
}

interface ListItemNode {
  id: string;
  type: string;
  content: (
    | { __typename: 'Issue'; id: string; number: number; title: string; url: string; state: string; labels: { nodes: { name: string }[] } }
    | { __typename: 'PullRequest'; id: string; number: number; title: string; url: string; state: string }
    | { __typename: 'DraftIssue'; id: string; title: string }
  ) | null;
  fieldValues: {
    nodes: (
      | { __typename: 'ProjectV2ItemFieldSingleSelectValue'; optionId: string; name: string; field: { id: string; name: string } }
    )[];
  };
}

export async function handleReady(rest: string[], flags: ParsedArgs['flags']): Promise<void> {
  const project = requireString(flags, 'project', rest);
  const owner = requireString(flags, 'owner', rest);
  const fieldName = optionalString(flags, 'field', rest) ?? 'Status';
  const statusName = optionalString(flags, 'status', rest) ?? 'Todo';
  const limit = Number(optionalString(flags, 'limit', rest) ?? '50');

  const client = new GitHubClient({ token: requireToken() });

  // 1. Find project + field + target option.
  // `findProjectByOwner` queries user and organization in parallel
  // because the GitHub GraphQL API is fail-fast on user/organization
  // type mismatches — see find-project.ts.
  const allProjects = await findProjectByOwner(client, owner, project);
  const matched = allProjects.find(
    (p) => p.title.toLowerCase() === project.toLowerCase() || p.title.toLowerCase().includes(project.toLowerCase())
  );
  if (!matched) {
    throw new Error(
      `ready: no project matching "${project}" found for ${owner}. Available: ${
        allProjects.map((p) => p.title).join(', ') || '(none)'
      }`
    );
  }
  const statusField = matched.fields.nodes.find(
    (f): f is typeof f & { __typename: 'ProjectV2SingleSelectField' } =>
      f.__typename === 'ProjectV2SingleSelectField' && f.name.toLowerCase() === fieldName.toLowerCase()
  );
  if (!statusField) {
    throw new Error(`ready: project "${matched.title}" has no single-select field "${fieldName}"`);
  }
  const targetOption = statusField.options?.find((o) => o.name.toLowerCase() === statusName.toLowerCase());
  if (!targetOption) {
    throw new Error(
      `ready: project "${matched.title}" field "${fieldName}" has no option "${statusName}". Available: ${
        statusField.options?.map((o) => o.name).join(', ') || '(none)'
      }`
    );
  }

  // 2. Paginate through items, filter to matching status.
  const matchedItems: Array<{
    issue_number: number;
    title: string;
    url: string;
    state: string;
    labels: string[];
    item_id: string;
  }> = [];

  let cursor: string | null = null;
  let fetched = 0;
  outer: while (fetched < limit * 2 /* fetch extra to allow for filtering */) {
    const data: ListItemsData = await client.graphql<ListItemsData>(LIST_ITEMS_IN_STATUS, {
      projectId: matched.id,
      fieldId: statusField.id,
      optionId: targetOption.id,
      cursor,
    });
    if (!data.node) break;
    for (const item of data.node.items.nodes) {
      const status = item.fieldValues.nodes.find(
        (v): v is { __typename: 'ProjectV2ItemFieldSingleSelectValue'; optionId: string; name: string; field: { id: string; name: string } } =>
          v.__typename === 'ProjectV2ItemFieldSingleSelectValue' &&
          v.field.name.toLowerCase() === fieldName.toLowerCase()
      );
      if (!status || status.optionId !== targetOption.id) continue;
      if (item.content && item.content.__typename === 'Issue') {
        matchedItems.push({
          issue_number: item.content.number,
          title: item.content.title,
          url: item.content.url,
          state: item.content.state,
          labels: item.content.labels.nodes.map((l: { name: string }) => l.name),
          item_id: item.id,
        });
        if (matchedItems.length >= limit) break outer;
      }
    }
    fetched += data.node.items.nodes.length;
    if (!data.node.items.pageInfo.hasNextPage) break;
    cursor = data.node.items.pageInfo.endCursor;
  }

  const format = pickFormat(flags, 'json');
  if (format === 'table') {
    emitTable(
      ['#', 'Title', 'State', 'Labels', 'URL'],
      matchedItems.map((m) => [
        String(m.issue_number),
        m.title,
        m.state,
        m.labels.join(','),
        m.url,
      ])
    );
  } else {
    emitJSON(matchedItems);
  }
}

function requireString(flags: ParsedArgs['flags'], key: string, positionals: string[]): string {
  const v = optionalString(flags, key, positionals);
  if (v) return v;
  throw new Error(`Missing required --${key}`);
}

function optionalString(flags: ParsedArgs['flags'], key: string, _positionals: string[]): string | undefined {
  const v = flags[key];
  if (typeof v === 'string' && v.length > 0) return v;
  if (v === true) return '';
  return undefined;
}
