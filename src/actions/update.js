'use strict'

const fs = require('fs')
const path = require('path')

const dataFile = path.resolve(__dirname, '..', '..', 'data.json')

const data = require(dataFile) || {}
data.packages = data.packages || {}
data.packages[process.env.package] = process.env.version

fs.writeFile(dataFile, JSON.stringify(data, null, 2), (err) => {
  if (err) {
    console.error(err)
  } else {
    process.send({ type: 'restart' })
  }

  process.exit(err ? 1 : 0)
})
