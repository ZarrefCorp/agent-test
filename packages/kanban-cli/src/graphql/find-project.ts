/**
 * Find a Projects v2 board by owner login + title.
 *
 * Tries `user(login)` and `organization(login)` in parallel via
 * `Promise.allSettled`. Each query is independent: if the login is a
 * User, the org query fails (and vice versa) but the other still
 * returns data. Both failing is treated as "not found".
 *
 * Why split the query: the GitHub GraphQL API is fail-fast. A single
 * query like `{ user(login: "OrgName") { ... } organization(login:
 * "OrgName") { ... } }` returns an error (not null) on the `user`
 * field when the login is an Organization, and that error poisons the
 * whole response, so the org branch is never evaluated.
 */
import type { GitHubClient } from './client.js';
import { FIND_USER_PROJECT, FIND_ORG_PROJECT } from './queries.js';

export interface ProjectNode {
  id: string;
  number: number;
  title: string;
  fields: {
    nodes: (
      | {
          __typename: 'ProjectV2SingleSelectField';
          id: string;
          name: string;
          options?: { id: string; name: string }[];
        }
      | { __typename: 'ProjectV2Field'; id: string; name: string }
    )[];
  };
}

interface FindUserProjectData {
  user: { projectsV2: { nodes: ProjectNode[] } } | null;
}

interface FindOrgProjectData {
  organization: { projectsV2: { nodes: ProjectNode[] } } | null;
}

export async function findProjectByOwner(
  client: GitHubClient,
  login: string,
  title: string
): Promise<ProjectNode[]> {
  const [userResult, orgResult] = await Promise.allSettled([
    client.graphql<FindUserProjectData>(FIND_USER_PROJECT, { login, title }),
    client.graphql<FindOrgProjectData>(FIND_ORG_PROJECT, { login, title }),
  ]);

  const projects: ProjectNode[] = [];
  if (userResult.status === 'fulfilled') {
    projects.push(...(userResult.value.user?.projectsV2.nodes ?? []));
  }
  if (orgResult.status === 'fulfilled') {
    projects.push(...(orgResult.value.organization?.projectsV2.nodes ?? []));
  }
  return projects;
}
