const core = require('@actions/core')
const github = require('@actions/github')
const { stringify } = require('csv-stringify/sync')
const { orderBy } = require('natural-orderby')
const eventPayload = require(process.env.GITHUB_EVENT_PATH)
const { GitHub } = require('@actions/github/lib/utils')
const { createAppAuth } = require('@octokit/auth-app')
const { owner, repo } = github.context.repo

const appId = core.getInput('appid', { required: false })
const privateKey = core.getInput('privatekey', { required: false })
const installationId = core.getInput('installationid', { required: false })

const token = core.getInput('token', { required: true })
const org = core.getInput('org', { required: false }) || eventPayload.organization.login
const weeks = core.getInput('weeks', { required: false }) || '4'
const sortColumn = core.getInput('sort', { required: false }) || 'additions'
const sortOrder = core.getInput('sort-order', { required: false }) || 'desc'
const jsonExport = core.getInput('json', { required: false }) || 'false'
const committerName = core.getInput('committer-name', { required: false }) || 'github-actions'
const committerEmail = core.getInput('committer-email', { required: false }) || 'github-actions@github.com'

let octokit
let columnDate
let fileDate

// GitHub App authentication
if (appId && privateKey && installationId) {
  octokit = new GitHub({
    authStrategy: createAppAuth,
    auth: {
      appId: appId,
      privateKey: privateKey,
      installationId: installationId
    }
  })
} else {
  octokit = github.getOctokit(token)
}

// Orchestrator
;(async () => {
  try {
    let repoArray = []
    let sumArray = []
    await getRepos(repoArray)
    await freqStats(repoArray, sumArray)
    await sortpushTotals(sumArray)
    if (jsonExport === 'true') {
    await json(sumArray)
    }
  } catch (error) {
    core.setFailed(error.message)
  }
})()

// Retrieve all repos for org
async function getRepos(repoArray) {
  try {
    let paginationMember = null

    const query = `
      query ($owner: String!, $cursorID: String) {
        organization(login: $owner) {
          repositories(first: 100, after: $cursorID) {
            nodes {
              name
              createdAt
              primaryLanguage {
                name
              }
              languages(first:100) {
                nodes {
                  name
                }
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
    `

    let hasNextPageMember = false
    let dataJSON = null

    do {
      dataJSON = await octokit.graphql({
        query,
        owner: org,
        cursorID: paginationMember
      })

      const repos = dataJSON.organization.repositories.nodes

      hasNextPageMember = dataJSON.organization.repositories.pageInfo.hasNextPage

      for (const repo of repos) {
        if (hasNextPageMember) {
          paginationMember = dataJSON.organization.repositories.pageInfo.endCursor
        } else {
          paginationMember = null
        }
        repoArray.push(repo)
      }
    } while (hasNextPageMember)
  } catch (error) {
    core.setFailed(error.message + "\n" + error.stack)
  }
}

// Retrieve code frequency data for the repo and set interval input selection
async function freqStats(repoArray, sumArray) {
  let repo
  for (repo of repoArray) {
    try {
      do {
        response = await octokit.rest.repos.getCodeFrequencyStats({
          owner: org,
          repo: repo.name
        })

        let weeksTotal
        let weeksInterval = []
        let logDate

        weeksTotal = response.data

        const fromdate = core.getInput('fromdate', { required: false }) || ''
        const todate = core.getInput('todate', { required: false }) || ''

        const regex = '([0-9]{4}-[0-9]{2}-[0-9]{2})'
        const flags = 'i'
        const re = new RegExp(regex, flags)

        if (weeksTotal !== undefined) {
          if (weeksTotal.length > 0) {
            if (re.test(fromdate, todate) !== true) {
              weeksInterval = weeksTotal.slice(-weeks)
              columnDate = `<${weeks} weeks`
              fileDate = `${weeks}-weeks`
              logDate = `last ${weeks} weeks`
            } else {
              to = new Date(todate).getTime() / 1000
              from = new Date(fromdate).getTime() / 1000
              for (const element of weeksTotal) {
                if (element[0] >= from && element[0] <= to) {
                  weeksInterval.push(element)
                }
                columnDate = `${fromdate} to ${todate}`
                fileDate = `${fromdate}-to-${todate}`
                logDate = `${fromdate} to ${todate}`
              }
            }

            intervalTotal = weeksInterval.reduce((r, a) => a.map((b, i) => (r[i] || 0) + b), []).slice(1)
            alltimeTotal = weeksTotal.reduce((r, a) => a.map((b, i) => (r[i] || 0) + b), []).slice(1)

            const additions = intervalTotal[0]
            const deletions = Math.abs(intervalTotal[1])
            const alltimeAdditions = alltimeTotal[0]
            const alltimeDeletions = Math.abs(alltimeTotal[1])
            const repoName = repo.name
            const createdDate = repo.createdAt.substr(0, 10)

            let primaryLanguage
            let allLanguages
            if (repo.primaryLanguage !== null) {
              primaryLanguage = repo.primaryLanguage.name
            }

            if (repo.languages !== null) {
              allLanguages = repo.languages.nodes.map((language) => language.name).join(', ')
            }
            sumArray.push({ repoName, additions, deletions, alltimeAdditions, alltimeDeletions, createdDate, primaryLanguage, allLanguages })
            console.log(repo.name)
          }
        }
      } while (response.status === 202)
    } catch (error) {
      console.error(error.message + "\n" + error.stack + "\n" + repo?.name)
    }
  }
}

// Create and push CSV report
async function sortpushTotals(sumArray) {
  try {
    const columns = {
      repoName: 'Repository',
      additions: `Lines added (${columnDate})`,
      deletions: `Lines deleted (${columnDate})`,
      alltimeAdditions: 'All time lines added',
      alltimeDeletions: 'All time lines deleted',
      primaryLanguage: 'Primary language',
      allLanguages: 'All languages',
      createdDate: 'Repo creation date'
    }

    const sortArray = orderBy(sumArray, [sortColumn], [sortOrder])
    const csv = stringify(sortArray, {
      header: true,
      columns: columns
    })

    const reportPath = `reports/${org}-${new Date().toISOString().substring(0, 19) + 'Z'}-${fileDate}.csv`
    const opts = {
      owner,
      repo,
      path: reportPath,
      message: `${new Date().toISOString().slice(0, 10)} code frequency report`,
      content: Buffer.from(csv).toString('base64'),
      committer: {
        name: committerName,
        email: committerEmail
      }
    }

    console.log(`Pushing CSV report to repository path: ${reportPath}`)

    await octokit.rest.repos.createOrUpdateFileContents(opts)
  } catch (error) {
    core.setFailed(error.message + "\n" + error.stack)
  }
}

// Create and push optional JSON report
async function json(sumArray) {
  try {
    const reportPath = `reports/${org}-${new Date().toISOString().substring(0, 19) + 'Z'}-${fileDate}.json`
    const opts = {
      owner,
      repo,
      path: reportPath,
      message: `${new Date().toISOString().slice(0, 10)} repo collaborator report`,
      content: Buffer.from(JSON.stringify(sumArray, null, 2)).toString('base64'),
      committer: {
        name: committerName,
        email: committerEmail
      }
    }

    console.log(`Pushing JSON report to repository path: ${reportPath}`)

    await octokit.rest.repos.createOrUpdateFileContents(opts)
  } catch (error) {
    core.setFailed(error.message + "\n" + error.stack)
  }
}
