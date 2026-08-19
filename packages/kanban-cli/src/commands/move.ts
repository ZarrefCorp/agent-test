import { GitHubClient, requireToken } from '../graphql/client.js';
import { GET_ISSUE_CARD, UPDATE_ITEM_STATUS } from '../graphql/queries.js';
import { findProjectByOwner, type ProjectNode } from '../graphql/find-project.js';
import { emitJSON, emitKV, pickFormat } from '../output.js';
import { handleComment } from './comment.js';
import type { ParsedArgs } from '../cli.js';

interface ProjectItemNode {
  id: string;
  project: { id: string };
  fieldValues: {
    nodes: (
      | { __typename: 'ProjectV2ItemFieldSingleSelectValue'; name: string; optionId: string; field: { id: string; name: string } }
    )[];
  };
}

interface GetIssueCardData {
  node: {
    projectItems: { nodes: ProjectItemNode[] };
  } | null;
}

interface UpdateItemStatusData {
  updateProjectV2ItemFieldValue: { projectV2Item: { id: string } } | null;
}

export async function handleMove(rest: string[], flags: ParsedArgs['flags']): Promise<void> {
  const issue = requireString(flags, 'issue', rest);
  const project = requireString(flags, 'project', rest);
  const to = requireString(flags, 'to', rest);
  const owner = requireString(flags, 'owner', rest);
  const fieldName = optionalString(flags, 'field', rest) ?? 'Status';
  const commentBody = optionalString(flags, 'comment', rest);
  const commentOnlyIfMoved = flags['comment-only-if-moved'] === 'true' || flags['comment-only-if-moved'] === true;

  const client = new GitHubClient({ token: requireToken() });

  // 1. Find project + status field + target option.
  // `findProjectByOwner` queries user and organization in parallel
  // because the GitHub GraphQL API is fail-fast: passing an org login
  // to `user(login:)` errors the whole response, so we can't combine
  // them in one query.
  const allProjects = await findProjectByOwner(client, owner, project);
  const matched = allProjects.find(
    (p) => p.title.toLowerCase() === project.toLowerCase() || p.title.toLowerCase().includes(project.toLowerCase())
  );
  if (!matched) {
    throw new Error(
      `move: no project matching "${project}" found for ${owner}. Available: ${
        allProjects.map((p) => p.title).join(', ') || '(none)'
      }`
    );
  }
  const statusField = matched.fields.nodes.find(
    (f): f is ProjectNode['fields']['nodes'][number] & { __typename: 'ProjectV2SingleSelectField' } =>
      f.__typename === 'ProjectV2SingleSelectField' && f.name.toLowerCase() === fieldName.toLowerCase()
  );
  if (!statusField) {
    throw new Error(
      `move: project "${matched.title}" has no single-select field "${fieldName}". Available: ${
        matched.fields.nodes.map((f) => f.name).join(', ')
      }`
    );
  }
  const targetOption = statusField.options?.find((o) => o.name.toLowerCase() === to.toLowerCase());
  if (!targetOption) {
    throw new Error(
      `move: project "${matched.title}" field "${fieldName}" has no option "${to}". Available: ${
        statusField.options?.map((o) => o.name).join(', ') || '(none)'
      }`
    );
  }

  // 2. Find the issue's item on this project.
  const issueNodeId = await resolveIssueNodeId(client, owner, issue);
  const cardData = await client.graphql<GetIssueCardData>(GET_ISSUE_CARD, {
    issueNodeId,
    projectId: matched.id,
  });
  if (!cardData.node) {
    throw new Error(`move: could not load issue ${issue}`);
  }
  const item = cardData.node.projectItems.nodes.find((n) => n.project.id === matched.id);
  if (!item) {
    throw new Error(`move: issue ${issue} is not on project "${matched.title}"`);
  }

  // 3. Check current status.
  const current = item.fieldValues.nodes.find(
    (v) =>
      v.__typename === 'ProjectV2ItemFieldSingleSelectValue' &&
      v.field.name.toLowerCase() === fieldName.toLowerCase()
  ) as { optionId: string; name: string } | undefined;
  const moved = !current || current.optionId !== targetOption.id;

  if (moved) {
    await client.graphql<UpdateItemStatusData>(UPDATE_ITEM_STATUS, {
      projectId: matched.id,
      itemId: item.id,
      fieldId: statusField.id,
      optionId: targetOption.id,
    });
  }

  // 4. Comment (optional).
  let commented = false;
  if (commentBody && !(commentOnlyIfMoved && !moved)) {
    await handleComment([issue, '--body', commentBody], { body: commentBody });
    commented = true;
  }

  const out = {
    moved: String(moved),
    new_status_name: targetOption.name,
    new_status_option_id: targetOption.id,
    commented: String(commented),
  };

  const format = pickFormat(flags, 'kv');
  if (format === 'json') {
    emitJSON(out);
  } else {
    emitKV(out);
  }
}

async function resolveIssueNodeId(client: GitHubClient, owner: string, number: string): Promise<string> {
  const repo = process.env['GITHUB_REPOSITORY'];
  if (!repo) {
    throw new Error('move: GITHUB_REPOSITORY must be set (owner/repo)');
  }
  const [repoOwner, repoName] = repo.split('/');
  if (repoOwner !== owner) {
    // For org-level projects spanning repos, the caller must set
    // GITHUB_REPOSITORY to the issue's repo, or pass --issue-repo.
  }
  const data = await client.rest<{ node_id: string }>('GET', `/repos/${repoOwner}/${repoName}/issues/${number}`);
  return data.node_id;
}

function requireString(flags: ParsedArgs['flags'], key: string, positionals: string[]): string {
  const v = optionalString(flags, key, positionals);
  if (v) return v;
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
