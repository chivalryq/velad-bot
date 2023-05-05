/**
 * This is the entry point for your Probot App.
 * @param {import('probot').Application} app - Probot's Application class.
 */
const { exec } = require('child_process')
const path = require('path')
const fs = require('fs')
const simpleGit = require('simple-git')
const os = require('os')
const util = require('util')
const { Octokit } = require('@octokit/rest')
const { createAppAuth } = require('@octokit/auth-app')

const execAsync = util.promisify(exec)

const velaRepo = 'kubevela/kubevela'
const testRepo = 'chivalryq/test-matrix-on-tags'
const testRepoOnwer = testRepo.split('/')[0]
const testRepoBranch = 'main'
const testRepoName = testRepo.split('/')[1]
const veladURL = 'https://github.com/kubevela/velad'
const catalogRepo = 'kubevela/catalog'
const catalogRepoOwner = catalogRepo.split('/')[0]
const catalogRepoName = catalogRepo.split('/')[1]
const catalogRepoMainBranch = 'master'
const watchRepo = testRepo

const privateKey = process.env.PRIVATE_KEY
const appId = process.env.APP_ID
const installationId = process.env.INSTALLATION_ID

const VeladPRTitlePrefix = 'Bump kubevela version to '

const tmpParentDir = path.join(os.tmpdir(), 'velad')
if (!fs.existsSync(tmpParentDir)) {
  fs.mkdirSync(tmpParentDir)
}

async function cloneRepository (repoUrl, repoPath) {
  const git = simpleGit(repoPath)
  await git.clone(repoUrl, repoPath)
  return repoPath
}

async function upgradeVela (repoPath, tagName) {
  const upgradeScript = path.join(repoPath, 'hack', 'upgrade_vela.sh')
  const { stdout, stderr } = await execAsync(`${upgradeScript} ${tagName}`, { cwd: repoPath })
  if (stderr) {
    console.error(stderr)
  }
  console.log(`stdout: ${stdout}`)
}

async function upgradeVelaUX (repoPath, tagName) {
  const upgradeScript = path.join(repoPath, 'hack', 'upgrade_velaux.sh')
  const { stdout, stderr } = await execAsync(`${upgradeScript} ${tagName} ${tagName}`, { cwd: repoPath })
  if (stderr) {
    console.error(stderr)
  }
  console.log(`stdout: ${stdout}`)
}

async function upgradeAndPushBranch (gitRepo, repoPath, tagName, upgradeFunc, branchName, commitMessage,) {
  await gitRepo.addConfig('user.name', 'velad-bot')
  await gitRepo.addConfig('user.email', 'chivalry.pp@gmail.com')

  await upgradeFunc(repoPath, tagName)

  await gitRepo.checkoutLocalBranch(branchName)
  await gitRepo.add('./*')
  await gitRepo.commit(commitMessage, { '--signoff': null })

  const gitToken = process.env.GITHUB_TOKEN
  const remoteUrlWithToken = veladURL.replace('https://', `https://${gitToken}@`)
  await gitRepo.addRemote('authenticated', remoteUrlWithToken)
  await gitRepo.push(['--set-upstream', 'authenticated', branchName])
}

async function createPullRequest (octokit, prDetails) {
  await octokit.pulls.create(prDetails)
}

module.exports = (app) => {
  const auth = {
    appId,
    privateKey,
    installationId,
  }

  const octokit = new Octokit({
    auth: auth,
    authStrategy: createAppAuth,
  })

  app.on(['release.published'], async (context) => {
    if (context.payload.repository.full_name === watchRepo) {
      const tagName = context.payload.release.tag_name
      const prTitle = VeladPRTitlePrefix + tagName
      const prBody = 'Update kubevela/velad'

      try {
        const repoTmpDir = fs.mkdtempSync(path.join(tmpParentDir, 'velad-'))
        const repoPath = path.join(repoTmpDir, 'velad')
        if (!fs.existsSync(repoPath)) {
          fs.mkdirSync(repoPath)
        }

        await cloneRepository(veladURL, repoPath)
        app.log.info('Cloning ' + veladURL + ' to ' + repoPath)

        const branchName = 'velad-bot/bump-kubevela-version-' + tagName
        const gitRepo = simpleGit(repoPath)
        await upgradeAndPushBranch(gitRepo, repoPath, tagName, upgradeVela,
          branchName, prTitle)
        app.log.info('Pushed to ' + branchName)

        // Create a pull request
        const pr = {
          owner: 'kubevela',
          repo: 'velad',
          title: prTitle,
          head: branchName,
          base: 'main',
          body: prBody,
        }

        await createPullRequest(octokit, pr)
        app.log.info('Created PR ' + prTitle)
      } catch (error) {
        app.log.error('failed to create PR', error)
      }
    }
  })

  // on catalog repo if there is a new pr merged, then find the pr in velad repo and update the pr
  app.on(['pull_request.closed'], async (context) => {
    const { payload } = context
    const { repository, pull_request } = payload

    // Check if the PR was merged
    if (!pull_request.merged) {
      app.log.info('PR was closed without merging')
      return
    }
    // todo: change to catalogRepo before release
    if (repository.full_name !== testRepo) {
      app.log.info('Not in the watch repo', repository.full_name)
      return
    }

    // Get the list of changed files in the merged PR
    const { data: files } = await octokit.pulls.listFiles({
      owner: repository.owner.login,
      repo: repository.name,
      pull_number: pull_request.number,
    })

    filenames = files.map((file) => file.filename)

    // Check if the PR contains a file named 'metadata.yaml'
    app.log.info('PR merged:', pull_request.id)
    app.log.info('Changed files:', filenames)

    if (!filenames.includes('addons/velaux/metadata.yaml')) {
      app.log.info('VelaUX metadata.yaml not modified, skip')
    }

    // Get the metadata.yaml file from the catalog repo
    // This indicates that PR is merged to master branch
    const { data: metadata } = await octokit.repos.getContent({
      // todo: change to catalogRepo before release
      owner: testRepoOnwer,
      repo: testRepoName,
      path: 'addons/velaux/metadata.yaml',
      ref: testRepoBranch,
      mediaType: {
        format: 'raw',
      }
    })

    // Get version like v1.7.6
    const newVersion = /version: (\S+)/.exec(metadata)[1]
    app.log.info('Got VelaUX addon current version in catalog:', newVersion)

    // Get the PR in VelaD repo. Will try to get the latest one, update the VELAUX_VERSION in Makefile
    const { data: veladPRs }
      = await octokit.pulls.list({
      owner: 'kubevela',
      repo: 'velad',
      state: 'open',
      head: 'velad-bot',
      base: 'main',
      sort: 'updated',
      direction: 'desc',
    })

    // Get the latest PR with title "Bump kubevela version to"
    const veladPR = veladPRs.find((pr) => pr.title.startsWith(VeladPRTitlePrefix))
    if (!veladPR) {
      app.log.info('No VELAD PR found')
      return
    }
    const { number: prNumber, title: prTitle, body: prBody, head: prHead } = veladPR
    app.log.info('Got VELAD PR:', prNumber)

    // Clone this PR branch to local
    const repoTmpDir = fs.mkdtempSync(path.join(tmpParentDir, 'velad-'))
    const repoPath = path.join(repoTmpDir, 'velad')
    if (!fs.existsSync(repoPath)) {
      fs.mkdirSync(repoPath)
    }

    // Clone the repository and set up the local repo
    await cloneRepository(veladURL, repoPath)
    const gitRepo = simpleGit(repoPath)

    // Fetch the PR's branch and check it out
    const prRef = `pull/${prNumber}/head`
    await gitRepo.fetch('origin', prRef)
    await gitRepo.checkout(prHead.ref)

    const branchName = 'velad-bot/bump-velaux-version-' + newVersion
    const commitMessage = 'Bump VelaUX version to ' + newVersion
    await upgradeAndPushBranch(gitRepo, repoPath, newVersion, upgradeVelaUX, branchName, commitMessage)

    // Create a new PR with the new branch
    const { data: newPR } = await octokit.pulls.create({
      owner: 'kubevela',
      repo: 'velad',
      title: prTitle,
      head: branchName,
      base: 'main',
      body: prBody,
    })
    app.log.info('Created new VelaD PR with new branch', newPR)

    // Close the old PR
    await octokit.pulls.update({
      owner: 'kubevela',
      repo: 'velad',
      pull_number: prNumber,
      state: 'closed',
    })
    app.log.info('Closed old VelaD PR')


  })
}

