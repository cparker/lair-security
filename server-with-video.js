'use strict'

const express = require('express')
const morgan = require('morgan')
const app = express()
const bodyParser = require('body-parser')
const cookieParser = require('cookie-parser')
const server = require('http').createServer(app)
const io = require('socket.io')(server, {
    path: '/mystuff'
})
// const io = require('socket.io')(server)
const {
    exec
} = require('child_process')

const AWS = require('aws-sdk')
const fs = require('fs')
const process = require('process')

const port = process.env.PORT || 5000
const rekognition = new AWS.Rekognition()
const motionPin = process.env.MOTION_PIN || 21
const cookieName = 'lairSecurityID'

const WebStreamerServer = require('./raspi-stream/raspivid')
let alarmTimeout

// command to put the display to sleep
const sleepMonitorCommand = process.env.SLEEP_MON || 'vcgencmd display_power 0'

// command to wake up the display
const wakeMonitorCommand = process.env.WAKE_MON || 'vcgencmd display_power 1'

// alarm resets after no motion for this many seconds
const alarmResetTimeSec = process.env.ALARM_RESET_SEC || 30

const authorizedFacesFilename = 'authorizedFaces.jpg'

const matchThreshold = 80

let lastMotionTimestamp = (new Date()).getTime()

let gpio
let client

let players = []

// ARMED, AUTHENTICATING-LOCAL, AUTHENTICATING-REMOTE, AUTHENTICATED,
let state = 'ARMED'

app.use(morgan('dev'))
app.use(cookieParser())

app.use((req, res, next) => {
    res.set('Cache-Control', 'no-cache, must-revalidate, no-store, max-age=0')
    next()
})

app.use(express.static(__dirname + '/node_modules'))
app.use(express.static(__dirname + '/images'))
app.use(express.static(__dirname + '/sound'))

// we need this explicit route so we can deal with cookies here
app.get('/', function(req, res, next) {
    if (!req.cookies[cookieName]) {
        console.log('this user has no cookie, so sad')
        res.cookie(cookieName, (new Date()).getTime())
    } else {
        console.log('this user has a cookie', req.cookies[cookieName])
    }

    res.sendFile(__dirname + '/index.html')
})

app.use(express.static('.'))
app.use(bodyParser.json())
app.use(bodyParser.urlencoded({
    extended: true
}))
app.use(bodyParser.raw({
    type: 'text/plain',
    limit: '200mb'
}))

app.post('/savepic', (req, res, next) => {
    console.log('savepic')
    const postText = req.body.toString('utf-8')
    const base64Text = postText.split('base64,')[1]
    const base64Data = Buffer.from(base64Text, 'base64')
    fs.writeFileSync('canvas-snap.png', base64Data)
})

/*
  The API takes a source and target image, then returns an array of matched faces in the TARGET
  So we'll use the authorizedFaces as the source and pass the new capture as the target
*/
app.post('/uploadSnapAndCompare', async(req, res, next) => {
    console.log('uploadSnapAndCompare')
    const postText = req.body.toString('utf-8')
    const base64Text = postText.split('base64,')[1]
    const base64Data = Buffer.from(base64Text, 'base64')
    const imageFileName = 'sourceImage.png'
    fs.writeFileSync(imageFileName, base64Data)

    try {
        // doing both compare faces AND analyze faces in parallel
        const comparePromise = compareFacesPromise(authorizedFacesFilename, imageFileName)
        const detectPromise = detectFaceAWSPromise(imageFileName)
        const [compareResult, detectResult] = await Promise.all([comparePromise, detectPromise])

        const finalResponse = {
            compareResult: compareResult,
            detectResult: detectResult
        }

        if (compareResult.FaceMatches && compareResult.FaceMatches.length > 0 && compareResult.FaceMatches[0].Similarity >= matchThreshold) {
            // attach a simple boolean to response
            finalResponse.authenticated = true
            console.log('auth succeeded clearing alarm timeout')
            if (alarmTimeout) {
                clearTimeout(alarmTimeout)
            }
        } else {
            finalResponse.authenticated = false
        }
        res.status(201).json(finalResponse)
    } catch (err) {
        console.log(err)
        res.status(500).send(err)
    }
})

const raspiVideoStreamOptions = {
    width: 1280,
    height: 768,
    rotation: 90,
    fps: 12
}

let getCookieID = (cookieHeader) => {
    return (() => {
        try {
            return cookieHeader.split(';').find(x => x.indexOf(cookieName) !== -1).split('=')[1]
        } catch (e) {
            return null
        }
    })()
}

// CONFIGURE GPIO for motion sensor
console.log(`NODE_ENV is ${process.env.NODE_ENV}`)
if (process.env.NODE_ENV !== 'test') {
    console.log(`configuring GPIO`)
    gpio = require('rpi-gpio')
    gpio.setMode(gpio.MODE_BCM)
    gpio.setup(motionPin, gpio.DIR_IN, gpio.EDGE_RISING)
    console.log(`set gpio pin ${motionPin} to INPUT detect rising`)
}

io.of('/fred').on('connection', localClient => {
    // FIXME: note that we're storing the last connected client globally
    console.log('client connected')
    client = localClient
    console.log('HEADERS', client.handshake.headers)
    const cookieID = getCookieID(client.handshake.headers.cookie)

    if (!cookieID) {
        console.log('could not get a cookieID')
        return
    }

    client.on('join', data => {
        console.log(`player has joined, and their ID is ${cookieID}`)

        console.log('players now', players)
    })

    client.on('snap', () => {
        console.log('snap')
        findAWSFace()
    })

})

io.on('disconnect', client => {
    console.log('disconnect client.conn.id', client.conn.id)
})

const silence = new WebStreamerServer(server, raspiVideoStreamOptions)

server.listen(port, '0.0.0.0', () => {
    console.log(`listening on ${port}`)
})

/*
  Called if there was motion NOT followed by successful auth
*/
function noAuthWithinPeriod() {
    console.log('NO AUTH FOLLOWING MOTION, so trigger an alarm at this point')
}

// WAIT FOR MOTION
if (process.env.NODE_ENV !== 'test') {
    console.log(`detecting change on pin ${motionPin}`)
    gpio.on('change', function(channel, value) {
        console.log(`motion state changed, value ${value} on channel ${channel}`)
        // check to see how long since last motion
        if ((new Date()).getTime() - lastMotionTimestamp > alarmResetTimeSec * 1000) {
            console.log(`alarm reset period exceeded, triggering alarm`)

            // there was no motion for a long enough period, followed by motion, so we need to authenticate

            // turn on the monitor
            exec(wakeMonitorCommand)

            // alert the browser
            if (client) {
                client.emit('motionAlarm', {})
            }

            // set a timeout to fire within a minute if no successful auth
            alarmTimeout = setTimeout(noAuthWithinPeriod, 60 * 1000)
        }
        lastMotionTimestamp = (new Date()).getTime()
    })
}

function compareFacesPromise(sourceFilename, targetFilename) {
    return new Promise((resolve, reject) => {
        const sourceBuffer = fs.readFileSync(sourceFilename)
        const targetBuffer = fs.readFileSync(targetFilename)
        const params = {
            SourceImage: {
                Bytes: sourceBuffer
            },
            TargetImage: {
                Bytes: targetBuffer
            }
        }
        console.log('params', params)
        rekognition.compareFaces(params, (err, data) => {
            if (err) {
                console.log('error in compare faces', err, err.stack)
                reject(err)
            } else {
                resolve(data)
            }
        })
    })

}

function detectFaceAWSPromise(filename) {
    return new Promise((resolve, reject) => {
        let picBuffer = fs.readFileSync(filename)

        let params = {
            Image: {
                Bytes: picBuffer
            },
            Attributes: ['ALL']
        }

        rekognition.detectFaces(params, (err, data) => {
            if (err) {
                console.log(err, err.stack)
                reject(err)
            } else {
                console.log(JSON.stringify(data, null, 2))
                resolve(data)
            }
        })

    })
}

setTimeout(() => {
    if (client) {
        console.log('emiting')
        client.emit('test', {
            data: 'man this is great data'
        })
    }
}, 1000)

async function go() {
    const compareResults = await compareFacesPromise('testSource.png', 'testTarget.jpg')
    console.log('compareResults', JSON.stringify(compareResults, null, 2))
}
