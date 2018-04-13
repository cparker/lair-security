'use strict'

const express = require('express')
const morgan = require('morgan')
const app = express()
const bodyParser = require('body-parser')
const cookieParser = require('cookie-parser')
const server = require('http').createServer(app)
const io = require('socket.io')(server, {path:'/mystuff'})
//const io = require('socket.io')(server)
const RaspiCam = require('raspicam')
const { exec } = require('child_process')
const path = require('path')

const AWS = require('aws-sdk')
const fs = require('fs')
const process = require('process')

const port = process.env.PORT || 5000
const rekognition = new AWS.Rekognition()
const motionPin = process.env.MOTION_PIN || 21
const cookieName = 'lairSecurityID'
const defaultHeight = 800
const defaultWidth = 900

const WebStreamerServer = require('./raspi-stream/raspivid')

// command to put the display to sleep
const sleepMonitorCommand = process.env.SLEEP_MON || 'vcgencmd display_power 0'

// command to wake up the display
const wakeMonitorCommand = process.env.WAKE_MON || 'vcgencmd display_power 1'

// alarm resets after no motion for this many seconds
const alarmResetTimeSec = process.env.ALARM_RESET_SEC || 30

let lastMotionTimestamp = (new Date()).getTime()

let cv, gpio
let moveInterval, client
let moveIntervalPeriodMs = 5000
let moveItemCountMax = 5
let boardPieceMax = 20
let camera

let players = []
let playerConnections = []
let gameBoard = {
    boardPieces: [],
    level: -1
}

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
  const postText = req.body.toString('utf-8')
  const base64Text = postText.split('base64,')[1]
  const base64Data = Buffer.from(base64Text, 'base64')
  fs.writeFileSync('canvas-snap.png', base64Data)
})

const raspiVideoStreamOptions = {
  width:1024,
  height:768,
  rotation:90,
  fps:12
}


let getCookieID = (cookieHeader) => {
    return (() => {
        try {
            return cookieHeader.split(';').find(x => x.indexOf(cookieName) != -1).split('=')[1]
        } catch (e) {
            return null
        }
    })()
}

const captureFilename = 'camera-snapshot.png'

const imageCaptureCommand = process.env.IMAGE_CAPTURE_COMMAND ||
  `/opt/vc/bin/raspistill --output ${captureFilename} --encoding png  --width 1024 --height 768 --rotation 90 --timeout 1000 --nopreview`

const cameraOpts = {
    mode: 'photo',
    output: 'camera-snapshot.png',
    encoding: 'png',
    timeout: 500,
    width: 1280,
    height: 1024,
    rotation: 90
}

// CONFIGURE GPIO for motion sensor
console.log(`NODE_ENV is ${process.env.NODE_ENV}`)
if (process.env.NODE_ENV !== 'test') {
    console.log(`configuring GPIO`)
    camera = new RaspiCam(cameraOpts)
    cv = require('opencv')
    gpio = require('rpi-gpio')
    gpio.setMode(gpio.MODE_BCM)
    gpio.setup(motionPin, gpio.DIR_IN, gpio.EDGE_RISING)
    console.log(`set gpio pin ${motionPin} to INPUT detect rising`)
}

io.of('/fred').on('connection', localClient => {
    // FIXME: note that we're storing the last connected client globally
    console.log('client connected' )
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

// WAIT FOR MOTION
if (process.env.NODE_ENV !== 'test') {
    console.log(`detecting change on pin ${motionPin}`)
    gpio.on('change', function(channel, value) {
        console.log(`motion state changed, value ${value} on channel ${channel}`)
        // check to see how long since last motion
        if ((new Date()).getTime() - lastMotionTimestamp > alarmResetTimeSec * 1000) {
            console.log(`alarm reset period exceeded, triggering alarm`)
            exec(wakeMonitorCommand)
            if (client) {
                client.emit('alarm', {})
            }
        }
        lastMotionTimestamp = (new Date()).getTime()
        if (value && state === 'ARMED') {
            state = 'AUTHENTICATING-LOCAL'
            // authenticate()
        } else {
            console.log(`we have motion, but state is ${state}`)
        }
    })
}

async function findLocalFace() {

    const attempts = 10
    let found = false
    for (let i = 0; i < attempts && !found; i++) {
        try {
            let capturedFilename = await captureCameraImage()
            let face = await localFacePromise(capturedFilename)
            found = true
            console.log('GOT FACE', face)
        } catch (err) {
            console.log('GOT ERROR', err)
        }
    }
}

async function asyncFaceCapture() {
    try {
        let capture = await captureSimpleImage()
        if (client) {
            client.emit('newImageCaptured', {})
        }
    } catch (err) {
        console.log('GOT ERROR', err)
    }
}

async function findAWSFace() {
    try {
        let capture = await captureCameraImage()
        if (client) {
            client.emit('newImageCaptured', {})
        }
        // let face = await detectFaceAWSPromise(capture.filename)
        // client.emit('drawFace', face)
        // console.log('GOT FACE', face)
    } catch (err) {
        console.log('GOT ERROR', err)
    }

}

function authenticate() {
    if (client) {
        client.emit(state, {}) // tell the client we're authenticating local
    }
    captureCameraImage()
        .then(capturedImageFilename => {
            // tell the client to display the new image
            if (client) {
                client.emit('newImageCaptured', {})
            }

            // local face recognition
            return localFacePromise(capturedImageFilename)
        })
        .then(localFace => {
            console.log('found face', localFace)
            state = 'AUTHENTICATING-REMOTE'
            if (client) {
                client.emit(state, {})
            }

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
        console.log('starting capture')
        camera.start()
        console.log('capture has started')
        camera.on('read', (err, timestamp, filename) => {
            if (err) {
                console.log('error capturing camera image', err)
                camera.stop()
                reject(err)
            } else {
                console.log('captured camera image', filename)
                // camera.stop()
                resolve({
                    filename: filename,
                    timestamp: timestamp
                })
            }
        })
    })
}

function localFacePromise(savedImage) {
    console.log('looking for face in', savedImage.filename)
    const face_cascade = new cv.CascadeClassifier(path.join(__dirname, './node_modules', 'opencv', 'data', 'haarcascade_frontalface_alt2.xml'))

    return new Promise((resolve, reject) => {
        cv.readImage(savedImage.filename, (imageReadErr, image) => {
            if (imageReadErr) {
                console.log('image read error', imageReadErr)
                reject(imageReadErr)
            } else {
                face_cascade.detectMultiScale(image, (err, faces) => {
                    if (err) {
                        console.log('error ', err)
                        reject(err)
                    } else if (faces.length <= 0) {
                        console.log('NO FACES')
                        reject('NO FACE')
                    } else {
                        const face = faces[0] // only handle first face
                        const boxImageName = `${savedImage.filename}-box.png`
                        console.log('biggest face', JSON.stringify(faces[0], null, 2))
                        image.rectangle([face.x, face.y], [face.width, face.height], [0, 255, 0], 2)
                        image.save(boxImageName)
                        resolve({face: face, boxImageName: boxImageName})
                    }
                })
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

function captureSimpleImage() {
    return new Promise((resolve, reject) => {
        exec(imageCaptureCommand, (err, stdout, stderr) => {
            if (err) {
                console.log('error during image capture', err)
                reject(err)
            } else {
                console.log(stdout)
                console.log(stderr)
                resolve()
            }
        })
    })
}

setInterval(() => {
  if (client) {
    console.log('emiting')
    client.emit('test', {'data' : 'man this is great data'})
  }
}, 1000)

async function go() {
    while (true) {
        console.log('before face capture')
        await asyncFaceCapture()
        console.log('after face')
        // let faceData = await detectFaceAWSPromise(captureFilename)
        // if (client) {
        //   client.emit('drawFace', faceData)
        // }

    }
}

//go()

/*
setInterval(() => {
  if ((new Date()).getTime() - lastMotionTimestamp > alarmResetTimeSec * 1000) {
    console.log('monitor sleep')
    exec(sleepMonitorCommand)
  }
}, 5000)

*/
