import { WebClient } from '@slack/web-api';
import * as dateTime from 'date-time';
import { google } from 'googleapis';
import { CompareResponse } from './typings/github/compareResponse';
import { PullRequest } from './typings/github/pullRequest';
import { getNonEmptyOrThrow } from './util';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const github = require('octonode');

// read app config from environment variables.
const githubToken = getNonEmptyOrThrow(process.env.GITHUB_TOKEN);
const keyFile = getNonEmptyOrThrow(process.env.GOOGLE_CREDENTIALS_PATH);
const spreadsheetId = getNonEmptyOrThrow(process.env.GOOGLE_SHEET_ID);
const slackToken = getNonEmptyOrThrow(process.env.SLACK_TOKEN);
const slackChannel = getNonEmptyOrThrow(process.env.SLACK_CHANNEL);
const repos = getNonEmptyOrThrow(process.env.REPOS)
  .split(',')
  .map(r => r.trim());
const compare = process.env.COMPARE || 'release...master';

async function getPullRequests(repo: string): Promise<PullRequest[]> {
  return new Promise((resolve, reject) => {
    github.client(githubToken).get(`/repos/${repo}/compare/${compare}`, {}, function(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      err: any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      status: any,
      response: CompareResponse
    ) {
      if (!err) {
        const res: PullRequest[] = [];
        const re = /^Merge pull request #(\d+) .*/;
        for (const commit of response.commits) {
          const name = getNonEmptyOrThrow(commit.commit.author.name);
          const message = getNonEmptyOrThrow(commit.commit.message);
          // extract only merge commits.
          if (message.match(re)) {
            const lines = message.split(/\r?\n/g);
            const pr: PullRequest = {
              repo,
              id: getNonEmptyOrThrow(lines[0].match(re))[1],
              author: name,
              message: lines[2]
            };
            res.push(pr);
          }
        }
        resolve(res);
      } else {
        reject(err);
      }
    });
  });
}

async function generateReleaseSheet(prs: PullRequest[]): Promise<string> {
  // authentication with a service account key for google api.
  const auth = await google.auth.getClient({
    keyFile,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/drive.file'
    ]
  });
  const sheets = await google.sheets('v4');
  const title = dateTime();

  // create the new release sheet by copying from default sheet.
  const newSheetId = (
    await sheets.spreadsheets.sheets.copyTo({
      spreadsheetId,
      sheetId: 0, // 0 as 'template' sheet
      resource: {
        destinationSpreadsheetId: spreadsheetId
      },
      auth: auth
    } as object)
  ).data.sheetId;

  // rename the default name of the release sheet to current time string.
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    resource: {
      requests: [
        {
          updateSheetProperties: {
            fields: 'title,sheetId',
            properties: { sheetId: newSheetId, title }
          }
        }
      ]
    },
    auth
  } as object);

  // write rows in the release sheet.
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${title}!A3:C${prs.length + 2}`,
    valueInputOption: 'USER_ENTERED',
    resource: {
      values: prs
        .sort((a, b) => a.repo.localeCompare(b.repo))
        .map(p => [
          p.repo.split('/')[1],
          p.author,
          `=HYPERLINK("https://github.com/${p.repo}/pull/${p.id}", "${p.message}")`
        ])
    },
    auth
  } as object);

  return Promise.resolve(
    `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${newSheetId}`
  );
}

async function notifySlack(sheetUrl: string): Promise<void> {
  await new WebClient(slackToken).chat.postMessage({
    text: `[Release sheet]\n${sheetUrl}`,
    channel: slackChannel
  });
}

async function main(): Promise<void> {
  // retrieve pull requests from Github repositories.
  const prs: PullRequest[] = [];
  for (const repo of repos) {
    for (const pr of await getPullRequests(repo).catch(async e => Promise.reject(new Error(e)))) {
      prs.push(pr);
    }
  }

  // generate the release sheet.
  const sheetUrl = await generateReleaseSheet(prs);

  // notify slack channel of the release sheet link.
  await notifySlack(sheetUrl);
}

main();
