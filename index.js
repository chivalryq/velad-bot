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

// eslint-disable-next-line no-unused-vars
const velaRepo = 'kubevela/kubevela'
const testRepo = 'chivalryq/test-matrix-on-tags'
// eslint-disable-next-line no-unused-vars
const catalogRepo = 'kubevela/catalog'
var watchRepo = testRepo

const privateKey = process.env.PRIVATE_KEY
const appId = process.env.APP_ID
const installationId = process.env.INSTALLATION_ID

module.exports = app => {

  const auth = {
    appId,
    privateKey,
    installationId,
  }

  const octokit = new Octokit({
    auth: auth,
    authStrategy: createAppAuth,
  })

  app.on(['release.published'], async context => {
    if (context.payload.repository.full_name === watchRepo) {
      const tagName = context.payload.release.tag_name
      const prTitle = 'Bump kubevela version to ' + tagName
      const prBody = 'Update kubevela/velad'

      // Clone the velad repository
      const veladRepo = 'https://github.com/kubevela/velad.git'
      const tmpParentDir = path.join(os.tmpdir(), 'velad')
      if (!fs.existsSync(tmpParentDir)) {
        fs.mkdirSync(tmpParentDir)
      }
      const repoTmpDir = fs.mkdtempSync(path.join(tmpParentDir, 'velad-'))
      const repoPath = path.join(repoTmpDir, 'velad')
      const git = simpleGit(repoTmpDir)

      try {
        await git.clone(veladRepo, repoPath)
        app.log.info('Cloning ' + veladRepo + ' to ' + repoPath)

        // Execute the upgrade script
        const upgradeScript = path.join(repoPath, 'hack', 'upgrade_vela.sh')
        try {
          const { stdout, stderr } = await execAsync(`${upgradeScript} ${tagName}`, { cwd: repoPath })
          console.log(`stdout: ${stdout}`)
          console.error(`stderr: ${stderr}`)
        } catch (error) {
          console.error(`exec error: ${error}`)
          return
        }

        // Create a new branch and commit changes
        const newBranch = `velad-bot/bump-kubevela-version-${tagName}`
        const gitRepo = simpleGit(repoPath)
        await gitRepo.checkoutLocalBranch(newBranch)
        await gitRepo.addConfig('user.name', 'velad-bot')
        await gitRepo.addConfig('user.email', 'chivalry.pp@gmail.com')
        await gitRepo.add('./*')
        await gitRepo.commit(`Update kubevela version to ${tagName}`, { '--signoff': null })

        // Push the new branch to the remote repository
        const gitToken = process.env.GITHUB_TOKEN
        const remoteUrlWithToken = veladRepo.replace('https://', `https://${gitToken}@`)
        await gitRepo.addRemote('authenticated', remoteUrlWithToken)
        await gitRepo.push(['--set-upstream', 'authenticated', newBranch])
        app.log.info('Pushed to ' + newBranch)

        // create a pull request
        const pr = {
          owner: 'kubevela',
          repo: 'velad',
          title: prTitle,
          head: newBranch,
          base: 'main',
          body: prBody,
        }

        try {
          await octokit.pulls.create(pr)
          app.log.info('Created PR ' + prTitle)
        } catch (error) {
          console.error(`Error creating PR: ${error.message}`)
          console.error(`Error status: ${error.status}`)
        }

      } catch (error) {
        console.error('Error:', error)
      }
    }
  })
}
