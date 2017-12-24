'use strict'

const express = require('express')
const app = express()
const bodyParser = require('body-parser')
const cookieParser = require('cookie-parser')
const server = require('http').createServer(app)
const io = require('socket.io')(server)
const RaspiCam = require('raspicam')
const path = require('path')
const cv = require('opencv')
const AWS = require('aws-sdk')
const fs = require('fs')
const gpio = require('rpi-gpio')
const process = require('process')

const port = process.env.PORT || 5000
const rekognition = new AWS.Rekognition()
const motionPin = 14
const cookieName = 'lairSecurityID'
const defaultHeight = 800
const defaultWidth = 900

// command to put the display to sleep
const sleepMonitorCommand = process.env.SLEEP_MON || 'vcgencmd display_power 0'

// command to wake up the display
const wakeMonitorCommand = process.env.WAKE_MON || 'vcgencmd display_power 1'

gpio.setMode(gpio.MODE_BCM)
gpio.setup(motionPin, gpio.DIR_IN, gpio.EDGE_RISING)

let lastMotionTimestamp = (new Date()).getTime()

let moveInterval, client
let moveIntervalPeriodMs = 5000
let moveItemCountMax = 5
let boardPieceMax = 20

let players = []
let playerConnections = []
let gameBoard = {
    boardPieces: [],
    level: -1
}

// ARMED, AUTHENTICATING-LOCAL, AUTHENTICATING-REMOTE, AUTHENTICATED,
let state = 'ARMED'

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

let getCookieID = (cookieHeader) => {
    return (() => {
        try {
            return cookieHeader.split(';').find(x => x.indexOf(cookieName) != -1).split('=')[1]
        } catch (e) {
            return null
        }
    })()
}

const cameraOpts = {
    mode: 'timelapse',
    output: 'camera-snapshot.png',
    encoding: 'png',
    timelapse: 1000,
    timeout: 0
}

let camera = new RaspiCam(cameraOpts)

/*
*/

// start taking stills from raspi camera
camera.on('read', (err, timestamp, filename) => {
    if (err) {
        console.log('error reading camera', err)
    } else {
        console.log('captured image, doing local face recognition')

    }

})

io.on('connection', localClient => {
    // FIXME: note that we're storing the last connected client globally
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

    setInterval(() => {
        client.emit('newImageCaptured', {})
    }, 5000)
})

io.on('disconnect', client => {
    console.log('disconnect client.conn.id', client.conn.id)
})

server.listen(port, '0.0.0.0', () => {
    console.log(`listening on ${port}`)
})

gpio.on('change', function(channel, value) {
    console.log(`motion state changed, value ${value}`)
    if (value && state === 'ARMED') {
        state = 'AUTHENTICATING-LOCAL'
        authenticate()
    } else {
        console.log(`we have motion, but state is ${state}`)
    }
})

function authenticate() {
    client.emit(state, {}) // tell the client we're authenticating local
    captureCameraImage()
        .then(capturedImageFilename => {
            // tell the client to display the new image
            client.emit('newImageCaptured', {})

            // local face recognition
            return findLocalFace(capturedImageFilename)
        })
        .then(localFace => {
            console.log('found face', localFace)
            state = 'AUTHENTICATING-REMOTE'
            client.emit(state, {})

            return detectFaceAWSPromise(filename)
        })
        .then(awsResult => {
            console.log('aws service returned', awsResult)
        })
        .catch(err => {
            console.log('error', err)
        })
}

function captureCameraImage() {
    return new Promise((resolve, reject) => {
        camera.start()
        camera.on('start', () => {
            camera.on('read', (err, timestamp, filename) => {
                if (err) {
                    console.log('error capturing camera image', err)
                    camera.stop()
                    reject(err)
                } else {
                    console.log('captured camera image', filename)
                    camera.stop()
                    resolve({
                        filename: filename,
                        timestamp: timestamp
                    })
                }
            })
        })
    })
}

function findLocalFace(filename, attempts = 5) {
    return new Promise((resolve, reject) => {
        let attempt = 0
        foundFace = false
        while (attempt++ < attempts && !faceFound) {
            localFacePromise(filename)
                .then(face => {
                    faceFound = true
                    resolve(face)
                })
                .catch(err => {
                    if (attempt >= attempts) {
                        reject('could not detect face')
                    }
                })
        }
    })
}

function localFacePromise(filename) {
    const face_cascade = new cv.CascadeClassifier(path.join(__dirname, './node_modules', 'opencv', 'data', 'haarcascade_frontalface_alt2.xml'))

    let p = new Promise((resolve, reject) => {
        cv.readImage(filename, (err, image) => {
            face_cascade.detectMultiScale(image, (err, faces) => {
                if (err) {
                    console.log('error ', err)
                    reject(err)
                } else if (faces.length <= 0) {
                    console.log('NO FACES')
                    reject('NO FACE')
                } else {
                    const face = faces[0] // only handle first face
                    const boxImageName = `${filename}-box.png`
                    console.log('biggest face', JSON.stringify(faces[0], null, 2))
                    image.rectangle([face.x, face.y], [face.width, face.height], [0, 255, 0], 2)
                    image.save(boxImageName)
                    resolve({face: face, boxImageName: boxImageName})
                }
            })
        })
    })
    return p
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
