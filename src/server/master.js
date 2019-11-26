'use strict'

const childProcess = require('child_process')
const cluster = require('cluster')
const path = require('path')

const debug = require('debug')('live-reload:master')

const workerCount = 4 // require('os').cpus().length

/**
 * create a single child worker to run the server application on a separate core
 */
async function createWorker () {
  return new Promise((resolve) => {
    const worker = cluster.fork()
    // add an exit handler so cluster will replace worker in the event of an unintentional termination
    worker.on('exit', (code, signal) => {
      createWorker()
    })
    worker.on('listening', resolve)
  })
}

/**
 * create many child workers
 * default is the number of CPU cores on the current system
 * @param {int} n
 */
async function createWorkers (n = workerCount) {
  return Promise.all([...new Array(n)].map(createWorker))
}

/**
 * terminate a child process, gracefully if possible, or forcefully if necessary
 * @param {ChildProcess} worker
 */
function terminateWorker (worker, gracefulDelay = 5000, forcefulDelay = 10000) {
  // don't replace this worker when it terminates
  worker.removeAllListeners('exit')

  // attempt to shutdown gracefully
  worker.disconnect()
  // if worker is still running after 5s, terminate
  setTimeout(() => { worker.kill() }, gracefulDelay)
  // if worker is still running after 10s, force terminate
  setTimeout(() => { worker.process.kill() }, forcefulDelay)
}

/**
 * handle a message sent from a child process using node IPC
 * message could be sent from a cluster worker or a one-off child sub-process
 */
const messageHandler = proc => async msg => {
  const { type } = msg || {}

  if (type) {
    switch (type) {
      case 'restart':
        setupClusterListeners()
        debug('master event handlers updated')

        // capture an array of pre-existing cluster workers
        const oldWorkers = Object.values(cluster.workers)

        // create new cluster workers with updated code
        // await will ensure that all new workers are listening before continuing
        await createWorkers()

        // terminate all pre-existing workers
        oldWorkers.forEach(terminateWorker)

        break

      default:
        // start a new child process to execute the action
        const actionProcess = childProcess.fork(
          path.resolve(__dirname, '..', 'actions', `${type}.js`),
          { env: Object.assign({}, process.env, msg) }
        )

        actionProcess.on('error', (err) => {
          console.log('an error occurred')
        })

        // accept and handle messages from the action process
        actionProcess.on('message', messageHandler(actionProcess))

        // on completion, send a message back to the originating process
        actionProcess.on('exit', (code) => {
          if (code) {
            proc.send({ type: 'error', code })
          } else {
            proc.send({ type: 'complete' })
          }
        })
    }
  }
}

function setupClusterListeners () {
  delete require.cache[__filename]

  const { messageHandler } = require(__filename)
  cluster.removeAllListeners('message')
  cluster.on('message', (worker, msg) => {
    messageHandler(worker)(msg)
  })

  cluster.removeAllListeners('exit')
  cluster.on('exit', (worker, code, signal) => {
    debug(`[PID:${worker.process.pid}] Exited`)
  })
}

function main () {
  setupClusterListeners()
  createWorkers()
}

module.exports = main
module.exports.messageHandler = messageHandler
