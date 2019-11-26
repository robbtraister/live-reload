'use strict'

const express = require('express')
const debug = require('debug')(`live-reload:worker:${process.pid}`)

const data = require('../../data.json')

function main () {
  const app = express()

  app.post('/update', (req, res, next) => {
    const handleMessage = (msg) => {
      const { type } = msg
      switch (type) {
        case 'complete':
          res.sendStatus(200)
          process.off('message', handleMessage)
          break
        case 'error':
          res.sendStatus(500)
          process.off('message', handleMessage)
          break
      }
    }

    process.on('message', handleMessage)
    process.send({ type: 'update', package: 'test', version: +data.packages.test + 1 })
  })

  app.use((req, res, next) => {
    res.send({ version: data.packages.test })
  })

  const port = Number(process.env.PORT) || 8080
  return app.listen(port, (err) => {
    err
      ? console.error(err)
      : debug(`Listening on port: ${port}`)
  })
}

module.exports = main
