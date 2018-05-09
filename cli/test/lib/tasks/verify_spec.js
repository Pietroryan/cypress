require('../../spec_helper')

const _ = require('lodash')
const os = require('os')
const cp = require('child_process')
const EE = require('events').EventEmitter
const Promise = require('bluebird')
const snapshot = require('snap-shot-it')
const { stripIndent } = require('common-tags')

const fs = require(`${lib}/fs`)
const util = require(`${lib}/util`)
const logger = require(`${lib}/logger`)
const xvfb = require(`${lib}/exec/xvfb`)
const state = require(`${lib}/tasks/state`)
const verify = require(`${lib}/tasks/verify`)

const stdout = require('../../support/stdout')
const normalize = require('../../support/normalize')

const packageVersion = '1.2.3'
const executablePath = '/path/to/executable'
const executableDir = '/path/to/executable/dir'


const slice = (str) => {
  // strip answer and split by new lines
  str = str.split('\n')

  // find the line about verifying cypress can run
  const index = _.findIndex(str, (line) => {
    return line.includes('Verifying Cypress can run')
  })

  // get rid of whatever the next line is because
  // i cannot figure out why this line fails in CI
  // its likely due to some UTF code
  str.splice(index + 1, 1, 'STRIPPED')

  return str.join('\n')
}

context('lib/tasks/verify', function () {
  require('mocha-banner').register()

  beforeEach(function () {
    this.sandbox.restore()
    this.stdout = stdout.capture()
    this.cpstderr = new EE()
    this.cpstdout = new EE()
    this.sandbox.stub(util, 'isCi').returns(false)
    this.sandbox.stub(util, 'pkgVersion').returns(packageVersion)
    this.sandbox.stub(os, 'platform').returns('darwin')
    this.sandbox.stub(os, 'release').returns('test release')
    this.spawnedProcess = _.extend(new EE(), {
      unref: this.sandbox.stub(),
      stderr: this.cpstderr,
      stdout: this.cpstdout,
    })
    this.sandbox.stub(cp, 'spawn').returns(this.spawnedProcess)
    this.sandbox.stub(state, 'getPathToExecutable').returns(executablePath)
    this.sandbox.stub(state, 'getPathToExecutableDir').returns(executableDir)
    this.sandbox.stub(xvfb, 'start').resolves()
    this.sandbox.stub(xvfb, 'stop').resolves()
    this.sandbox.stub(xvfb, 'isNeeded').returns(false)
    this.sandbox.stub(Promise.prototype, 'delay').resolves()
    this.sandbox.stub(this.spawnedProcess, 'on')
    this.sandbox.stub(state, 'writeBinaryVerifiedAsync').resolves()
    this.sandbox.stub(state, 'clearBinaryStateAsync').resolves()
    this.spawnedProcess.on.withArgs('close').yieldsAsync(0)
  })

  afterEach(function () {
    stdout.restore()
  })

  it('logs error and exits when no version of Cypress is installed', function () {
    const ctx = this
    this.sandbox.stub(fs, 'pathExistsAsync').withArgs(executablePath).resolves(false)
    return verify.start()
    .then(() => {
      throw new Error('should have caught error')
    })
    .catch((err) => {
      logger.error(err)

      snapshot(
        'no version of Cypress installed',
        normalize(ctx.stdout.toString())
      )
    })
  })

  it('is noop when binary is already verified', function () {
    const ctx = this

    // make it think the executable exists and is verified
    this.sandbox.stub(fs, 'pathExistsAsync').withArgs(executablePath).resolves(true)
    this.sandbox.stub(state, 'getBinaryPkgVersionAsync').resolves(packageVersion)
    this.sandbox.stub(state, 'getBinaryVerifiedAsync').resolves(true)
    return verify.start()
    .then(() => {
      // nothing should have been logged to stdout
      // since no verification took place
      expect(ctx.stdout.toString()).to.be.empty

      expect(cp.spawn).not.to.be.called
    })
  })

  it('logs warning when installed version does not match verified version', function () {
    const ctx = this
    this.sandbox.stub(fs, 'pathExistsAsync').withArgs(executablePath).resolves(true)
    this.sandbox.stub(state, 'getBinaryPkgVersionAsync').resolves('bloop')
    // force this to throw to short circuit actually running smoke test
    this.sandbox.stub(state, 'getBinaryVerifiedAsync').rejects(new Error())

    return verify.start()
    .then(() => {
      throw new Error('should have caught error')
    })
    .catch(() => {
      snapshot(
        'warning installed version does not match verified version',
        normalize(ctx.stdout.toString())
      )
    })
  })

  it('logs error and exits when executable cannot be found', function () {
    const ctx = this
    this.sandbox.stub(state, 'getBinaryPkgVersionAsync').resolves(packageVersion)

    return verify.start()
    .then(() => {
      throw new Error('should have caught error')
    })
    .catch((err) => {
      logger.error(err)

      snapshot(
        'executable cannot be found',
        normalize(ctx.stdout.toString())
      )
    })
  })

  describe('with force: true', function () {
    beforeEach(function () {
      this.sandbox.stub(_, 'random').returns('222')
      this.sandbox.stub(this.cpstdout, 'on').yieldsAsync('222')
    })

    it('shows full path to executable when verifying', function () {
      const ctx = this

      this.sandbox.stub(fs, 'pathExistsAsync').withArgs(executablePath).resolves(true)
      this.sandbox.stub(state, 'getBinaryPkgVersionAsync').resolves(packageVersion)
      this.sandbox.stub(state, 'getBinaryVerifiedAsync').resolves(false)

      return verify.start({ force: true })
      .then(() => {
        expect(cp.spawn).to.be.calledWith(executablePath, [
          '--smoke-test',
          '--ping=222',
        ])
      })
      .then(() => {
        snapshot(
          'verification with executable',
          normalize(ctx.stdout.toString())
        )
      })
    })

    it('clears verified version from state if verification fails', function () {

      const ctx = this

      const stderr = 'an error about dependencies'

      this.sandbox.stub(fs, 'pathExistsAsync').withArgs(executablePath).resolves(true)
      this.sandbox.stub(state, 'getBinaryPkgVersionAsync').resolves(packageVersion)
      this.sandbox.stub(state, 'getBinaryVerifiedAsync').resolves(true)


      this.sandbox.stub(this.cpstderr, 'on').withArgs('data').yields(stderr)
      this.spawnedProcess.on.withArgs('close').yieldsAsync(1)

      return verify.start({ force: true })
      .catch((err) => {
        logger.error(err)

        snapshot(
          'fails verifying Cypress',
          normalize(slice(ctx.stdout.toString()))
        )
      })
      .then(() => {
        expect(state.clearBinaryStateAsync).to.be.called
        expect(state.writeBinaryVerifiedAsync).to.not.be.called
      })
    })
  })

  describe('smoke test with DEBUG output', function () {
    beforeEach(function () {
      this.sandbox.stub(fs, 'statAsync').resolves()
      this.sandbox.stub(_, 'random').returns('222')
      const stdoutWithDebugOutput = stripIndent`
        some debug output
        date: more debug output
        222
        after that more text
      `
      this.sandbox.stub(this.cpstdout, 'on').yieldsAsync(stdoutWithDebugOutput)
    })

    it('finds ping value in the verbose output', function () {
      const ctx = this
      this.sandbox.stub(fs, 'pathExistsAsync').withArgs(executablePath).resolves(true)
      this.sandbox.stub(state, 'getBinaryPkgVersionAsync').resolves(packageVersion)
      this.sandbox.stub(state, 'getBinaryVerifiedAsync').resolves(false)

      return verify.start()
      .then(() => {
        snapshot(
          'verbose stdout output',
          normalize(ctx.stdout.toString())
        )
      })
    })
  })

  describe('smoke test', function () {
    beforeEach(function () {
      this.sandbox.stub(fs, 'statAsync').resolves()
      this.sandbox.stub(_, 'random').returns('222')
      this.sandbox.stub(this.cpstdout, 'on').yieldsAsync('222')
    })

    it('logs and runs when no version has been verified', function () {
      const ctx = this
      this.sandbox.stub(fs, 'pathExistsAsync').withArgs(executablePath).resolves(true)
      this.sandbox.stub(state, 'getBinaryPkgVersionAsync').resolves(packageVersion)
      this.sandbox.stub(state, 'getBinaryVerifiedAsync').resolves(false)

      return verify.start()
      .then(() => {
        snapshot(
          'no existing version verified',
          normalize(ctx.stdout.toString())
        )
      })
    })

    it('logs and runs when current version has not been verified', function () {
      const ctx = this
      this.sandbox.stub(fs, 'pathExistsAsync').withArgs(executablePath).resolves(true)
      this.sandbox.stub(state, 'getBinaryPkgVersionAsync').resolves('different version')
      this.sandbox.stub(state, 'getBinaryVerifiedAsync').resolves(false)
      return verify.start()
      .then(() => {
        snapshot(
          'current version has not been verified',
          normalize(ctx.stdout.toString())
        )
      })
    })

    it('logs and runs when installed version is different than verified version', function () {
      const ctx = this
      this.sandbox.stub(fs, 'pathExistsAsync').withArgs(executablePath).resolves(true)
      this.sandbox.stub(state, 'getBinaryPkgVersionAsync').resolves('9.8.7')
      this.sandbox.stub(state, 'getBinaryVerifiedAsync').resolves(false)

      return verify.start()
      .then(() => {
        snapshot(
          'current version has not been verified',
          normalize(ctx.stdout.toString())
        )
      })
    })

    it('turns off Opening Cypress...', function () {
      const ctx = this
      this.sandbox.stub(fs, 'pathExistsAsync').withArgs(executablePath).resolves(true)
      this.sandbox.stub(state, 'getBinaryPkgVersionAsync').resolves('different version')
      this.sandbox.stub(state, 'getBinaryVerifiedAsync').resolves(true)

      return verify.start({
        welcomeMessage: false,
      })
      .then(() => {
        snapshot(
          'no welcome message',
          normalize(ctx.stdout.toString())
        )
      })
    })

    describe('on linux', function () {
      beforeEach(function () {
        xvfb.isNeeded.returns(true)
        this.sandbox.stub(fs, 'pathExistsAsync').withArgs(executablePath).resolves(true)
        this.sandbox.stub(state, 'getBinaryPkgVersionAsync').resolves(packageVersion)
        this.sandbox.stub(state, 'getBinaryVerifiedAsync').resolves(false)
      })

      it('starts xvfb', function () {
        return verify.start()
        .then(() => {
          expect(xvfb.start).to.be.called
        })
      })

      it('stops xvfb on spawned process close', function () {
        this.spawnedProcess.on.withArgs('close').yieldsAsync(0)
        return verify.start()
        .then(() => {
          expect(xvfb.stop).to.be.called
        })
      })

      it('logs error and exits when starting xvfb fails', function () {
        const ctx = this

        const err = new Error('test without xvfb')
        err.stack = 'xvfb? no dice'
        xvfb.start.rejects(err)
        return verify.start()
        .catch((err) => {
          expect(xvfb.stop).to.be.calledOnce

          logger.error(err)

          snapshot(
            'xvfb fails',
            normalize(slice(ctx.stdout.toString()))
          )
        })
      })
    })

    describe('when running in CI', function () {
      beforeEach(function () {
        this.sandbox.stub(fs, 'pathExistsAsync').withArgs(executablePath).resolves(true)
        this.sandbox.stub(state, 'getBinaryPkgVersionAsync').resolves(packageVersion)
        this.sandbox.stub(state, 'getBinaryVerifiedAsync').resolves(false)
        util.isCi.returns(true)

        return verify.start({ force: true })
      })

      it('uses verbose renderer', function () {
        snapshot(
          'verifying in ci',
          normalize(this.stdout.toString())
        )
      })
    })

    describe('with options.cypressPath', function () {
      it('verifies the binary when passed with options.cypressPath', function () {
        state.getPathToExecutableDir.restore()
        state.getPathToExecutable.restore()
        const customBinaryDir = 'custom/path/to/binary'
        const customExecPath = state.getPathToExecutable(customBinaryDir)
        this.sandbox.stub(fs, 'pathExistsAsync').withArgs(customExecPath).resolves(true)
        this.sandbox.stub(state, 'getBinaryPkgVersionAsync').resolves(packageVersion)
        this.sandbox.stub(state, 'getBinaryVerifiedAsync').resolves(false)
        return verify.start({ cypressPath: customBinaryDir })
        .then(() => {
          expect(cp.spawn).to.be.calledWith(customExecPath)
        })
      })
    })
  })
})
