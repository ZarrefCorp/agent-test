/**
 * GraphQL operations for Projects v2.
 *
 * Conventions:
 *   - All fragments are inlined per query to keep things simple.
 *   - Single-select options are matched by name (case-insensitive).
 *   - When an issue lives on multiple projects, we pick the project
 *     that matches `projectTitle` (case-insensitive substring).
 *
 * Note: We split the "find project by owner" query into two —
 * one for `user`, one for `organization`. The GitHub GraphQL API is
 * fail-fast: a query like `{ user(login: "OrgName") { ... } }` returns
 * an error (not null) when the login is an Organization, and that error
 * propagates to the whole response, so a single combined query would
 * also fail when the caller passes an org login. Use the
 * `findProjectByOwner` helper (in `./find-project.ts`) to query both
 * in parallel and merge results safely.
 */

const PROJECT_FIELDS = /* GraphQL */ `
  fields(first: 50) {
    nodes {
      __typename
      ... on ProjectV2SingleSelectField {
        id
        name
        options {
          id
          name
        }
      }
      ... on ProjectV2Field {
        id
        name
      }
    }
  }
`;

export const FIND_USER_PROJECT = /* GraphQL */ `
  query FindUserProject($login: String!, $title: String!) {
    user(login: $login) {
      projectsV2(first: 20, query: $title) {
        nodes {
          id
          number
          title
          ${PROJECT_FIELDS}
        }
      }
    }
  }
`;

export const FIND_ORG_PROJECT = /* GraphQL */ `
  query FindOrgProject($login: String!, $title: String!) {
    organization(login: $login) {
      projectsV2(first: 20, query: $title) {
        nodes {
          id
          number
          title
          ${PROJECT_FIELDS}
        }
      }
    }
  }
`;

export const GET_ISSUE_CARD = /* GraphQL */ `
  query GetIssueCard($issueNodeId: ID!, $projectId: ID) {
    node(id: $issueNodeId) {
      ... on Issue {
        id
        number
        title
        body
        url
        labels(first: 30) {
          nodes { name }
        }
        projectItems(first: 20) {
          nodes {
            id
            project { id number title }
            fieldValues(first: 50) {
              nodes {
                __typename
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name
                  optionId
                  field {
                    ... on ProjectV2SingleSelectField { id name }
                    ... on ProjectV2Field { id name }
                  }
                }
                ... on ProjectV2ItemFieldTextValue {
                  text
                  field { ... on ProjectV2Field { id name } }
                }
              }
            }
          }
        }
      }
    }
  }
`;

export const UPDATE_ITEM_STATUS = /* GraphQL */ `
  mutation UpdateItemStatus($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
    updateProjectV2ItemFieldValue(
      input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
        value: { singleSelectOptionId: $optionId }
      }
    ) {
      projectV2Item { id }
    }
  }
`;

export const LIST_ITEMS_IN_STATUS = /* GraphQL */ `
  query ListItemsInStatus(
    $projectId: ID!
    $fieldId: ID!
    $optionId: String!
    $cursor: String
  ) {
    node(id: $projectId) {
      ... on ProjectV2 {
        items(first: 50, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            type
            content {
              __typename
              ... on Issue {
                id
                number
                title
                url
                state
                labels(first: 20) { nodes { name } }
              }
              ... on PullRequest {
                id
                number
                title
                url
                state
              }
              ... on DraftIssue {
                id
                title
              }
            }
            fieldValues(first: 50) {
              nodes {
                __typename
                ... on ProjectV2ItemFieldSingleSelectValue {
                  optionId
                  name
                  field { ... on ProjectV2SingleSelectField { id name } }
                }
              }
            }
          }
        }
      }
    }
  }
`;

export const VIEWER_LOGIN = /* GraphQL */ `
  query ViewerLogin {
    viewer { login }
  }
`;
