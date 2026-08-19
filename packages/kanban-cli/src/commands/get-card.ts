import { GitHubClient, requireToken } from '../graphql/client.js';
import { GET_ISSUE_CARD } from '../graphql/queries.js';
import { findProjectByOwner, type ProjectNode } from '../graphql/find-project.js';
import { emitJSON, emitKV, pickFormat } from '../output.js';
import type { ParsedArgs } from '../cli.js';

interface ProjectFieldNode {
  __typename: string;
  id: string;
  name: string;
  options?: { id: string; name: string }[];
}

interface ProjectItemNode {
  id: string;
  project: { id: string; number: number; title: string };
  fieldValues: {
    nodes: (
      | { __typename: 'ProjectV2ItemFieldSingleSelectValue'; name: string; optionId: string; field: { id: string; name: string } }
      | { __typename: 'ProjectV2ItemFieldTextValue'; text: string; field: { id: string; name: string } }
    )[];
  };
}

interface GetIssueCardData {
  node: {
    id: string;
    number: number;
    title: string;
    body: string | null;
    url: string;
    labels: { nodes: { name: string }[] };
    projectItems: { nodes: ProjectItemNode[] };
  } | null;
}

function projectMatches(node: ProjectNode, query: string): boolean {
  const q = query.toLowerCase();
  return (
    node.title.toLowerCase() === q ||
    node.title.toLowerCase().includes(q) ||
    `#${node.number}` === q
  );
}

function findOptionId(field: ProjectFieldNode, name: string): string | undefined {
  if (field.__typename !== 'ProjectV2SingleSelectField') return undefined;
  const lower = name.toLowerCase();
  return field.options?.find((o) => o.name.toLowerCase() === lower)?.id;
}

function buildPrompt(input: {
  title: string;
  number: number;
  body: string | null;
  labels: string[];
  status: string | undefined;
  project: string;
}): string {
  const parts: string[] = [];
  parts.push(`# Issue #${input.number} — ${input.title}`);
  if (input.status) parts.push(`**Kanban status:** ${input.status}`);
  if (input.project) parts.push(`**Project:** ${input.project}`);
  if (input.labels.length > 0) parts.push(`**Labels:** ${input.labels.join(', ')}`);
  parts.push('');
  parts.push(input.body?.trim() || '_No description provided._');
  parts.push('');
  parts.push('## Acceptance criteria');
  parts.push(
    'Look for a checklist (`- [ ]` / `- [x]`) in the body above. If present, those are your acceptance criteria. ' +
    'If not present, infer a sensible Definition of Done from the title and description and list it in your PR description.'
  );
  parts.push('');
  parts.push('## Operating contract');
  parts.push('You are running in a GitHub Actions sandbox. See `AGENTS.md` at the repo root for the full rules.');
  return parts.join('\n');
}

export async function handleGetCard(rest: string[], flags: ParsedArgs['flags']): Promise<void> {
  const issue = requireString(flags, 'issue', rest);
  const project = requireString(flags, 'project', rest);
  const owner = optionalString(flags, 'owner', rest) ?? '';
  const fieldName = optionalString(flags, 'field', rest) ?? 'Status';
  const require = flags['require'] === 'true' || flags['require'] === true;

  if (!owner) {
    throw new Error('get-card: --owner is required (or set GITHUB_REPOSITORY_OWNER)');
  }

  const client = new GitHubClient({ token: requireToken() });

  // 1. Resolve the issue's node id.
  const issueNodeId = await resolveIssueNodeId(client, owner, issue);

  // 2. Find the project by title.
  // `findProjectByOwner` queries user and organization in parallel
  // because the GitHub GraphQL API is fail-fast on user/organization
  // type mismatches — see find-project.ts.
  const allProjects = await findProjectByOwner(client, owner, project);
  const matched = allProjects.find((p) => projectMatches(p, project));
  if (!matched) {
    if (require) {
      throw new Error(
        `get-card: no project matching "${project}" found for ${owner}. Available: ${
          allProjects.map((p) => p.title).join(', ') || '(none)'
        }`
      );
    }
    emitKV({ item_id: '', project_id: '', status_option_id: '', status_name: '', status_field_id: '', card_url: '' });
    return;
  }

  // 3. Fetch the issue's project items and find the one for this project.
  const cardData = await client.graphql<GetIssueCardData>(GET_ISSUE_CARD, {
    issueNodeId,
    projectId: matched.id,
  });
  if (!cardData.node) {
    throw new Error(`get-card: could not load issue ${issue}`);
  }
  const item = cardData.node.projectItems.nodes.find(
    (n) => n.project.id === matched.id
  );
  if (!item) {
    if (require) {
      throw new Error(
        `get-card: issue ${issue} is not on project "${matched.title}". Add it on the Projects page.`
      );
    }
    emitKV({
      item_id: '',
      project_id: matched.id,
      status_option_id: '',
      status_name: '',
      status_field_id: '',
      card_url: cardData.node.url,
    });
    return;
  }

  // 4. Find the status field + current option.
  const statusField = matched.fields.nodes.find(
    (f) => f.name.toLowerCase() === fieldName.toLowerCase()
  );
  if (!statusField) {
    throw new Error(
      `get-card: project "${matched.title}" has no field named "${fieldName}". Available: ${
        matched.fields.nodes.map((f) => f.name).join(', ')
      }`
    );
  }
  const currentValue = item.fieldValues.nodes.find(
    (v) =>
      v.__typename === 'ProjectV2ItemFieldSingleSelectValue' &&
      v.field.name.toLowerCase() === fieldName.toLowerCase()
  ) as
    | { __typename: 'ProjectV2ItemFieldSingleSelectValue'; name: string; optionId: string; field: { id: string; name: string } }
    | undefined;

  const prompt = buildPrompt({
    title: cardData.node.title,
    number: cardData.node.number,
    body: cardData.node.body,
    labels: cardData.node.labels.nodes.map((l) => l.name),
    status: currentValue?.name,
    project: matched.title,
  });

  const out = {
    item_id: item.id,
    project_id: matched.id,
    status_option_id: currentValue?.optionId ?? '',
    status_name: currentValue?.name ?? '',
    status_field_id: statusField.id,
    card_url: cardData.node.url,
    prompt,
  };

  const format = pickFormat(flags, 'kv');
  if (format === 'json') {
    emitJSON({
      issue: {
        number: cardData.node.number,
        title: cardData.node.title,
        url: cardData.node.url,
        labels: cardData.node.labels.nodes.map((l) => l.name),
      },
      project: { id: matched.id, number: matched.number, title: matched.title },
      status: currentValue
        ? { field_id: statusField.id, field_name: statusField.name, option_id: currentValue.optionId, name: currentValue.name }
        : null,
      item_id: out.item_id,
      card_url: out.card_url,
      prompt,
    });
  } else {
    emitKV(out);
  }
}

async function resolveIssueNodeId(client: GitHubClient, owner: string, number: string): Promise<string> {
  // Use the REST API to get the issue's node id. (GraphQL would also work,
  // but the REST endpoint gives us the node_id directly.)
  const repo = process.env['GITHUB_REPOSITORY'];
  if (!repo) {
    throw new Error('get-card: GITHUB_REPOSITORY must be set (owner/repo) to resolve issue node ids');
  }
  const [repoOwner, repoName] = repo.split('/');
  if (repoOwner !== owner) {
    // Different owner than the repo owner — we still need a repo to look up
    // the issue. For org projects that span repos, the caller should set
    // GITHUB_REPOSITORY to the issue's repo.
  }
  const data = await client.rest<{ node_id: string }>('GET', `/repos/${repoOwner}/${repoName}/issues/${number}`);
  return data.node_id;
}

function requireString(flags: ParsedArgs['flags'], key: string, positionals: string[]): string {
  const fromFlag = optionalString(flags, key, positionals);
  if (fromFlag) return fromFlag;
  // Allow `--key value` from positional usage like `kanban get-card 123 --project ...`
  // First positional is treated as the issue number.
  if (key === 'issue' && positionals[0] && !positionals[0].startsWith('-')) {
    return positionals[0];
  }
  throw new Error(`Missing required --${key}`);
}

function optionalString(flags: ParsedArgs['flags'], key: string, _positionals: string[]): string | undefined {
  const v = flags[key];
  if (typeof v === 'string' && v.length > 0) return v;
  if (v === true) return '';
  return undefined;
}
