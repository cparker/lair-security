let page, mySocket

const test = true

const authenticationAttemptMax = 2
const countdownSteps = 5
const imageWidth = 1280
const imageHeight = 768

function init() {
    console.log('initializing')
    page = getPageElements()

    page.mainCanvas.width = imageWidth
    page.mainCanvas.height = imageHeight
    page.faceGeoCanvas.width = imageWidth
    page.faceGeoCanvas.height = imageHeight

    // initialize socketio
    mySocket = io('/fred', {
        path: '/mystuff'
    }).connect()

    mySocket.on('connect', handleSocketConnect)
    mySocket.on('motionAlarm', handleMotionActivation)

    // test buttons
    page.start.addEventListener('click', startStreamingVideo)
    page.startCountdown.addEventListener('click', testSimulateMotion)
}

/*
  top level function that drives the sequence of everything
*/
async function authenticate() {
    return new Promise(async(resolve, reject) => {
        let authenticationAttempts = 0
        let authSucceeded = false
        let snapshotResult

        while (!authSucceeded && authenticationAttempts < authenticationAttemptMax) {
            startStreamingVideo()
            await displayCountdown()
            const snapshotURL = await takeSnapshot()

            stopStreamingVideo()

            // display the snapshot
            page.stillImageElm.src = snapshotURL
            page.mainCanvas.style.display = 'none'
            page.stillImageElm.style.display = 'block'

            try {
                authenticationAttempts += 1
                console.log(`auth attempt ${authenticationAttempts}`)
                /*
                  The API will return 200 OK regardless of whether or not photos match.
                  So we need to add logic here to determine if auth succeeded ro not

                  The server will add a simple boolean to the top, authenticated:true | false
                */
                snapshotResult = await analyzeSnapshot(snapshotURL)
                console.log('snapshotResult', snapshotResult)
                displaySnapshotResult(snapshotResult)
                authSucceeded = snapshotResult.authenticated
                if (!snapshotResult.authenticated) {
                    await displayAuthFailure()
                }
            } catch (err) {
                console.log('auth attempt failed with exception', err)
                authSucceeded = false
                await displayAuthFailure()
            }
        }

        if (authSucceeded) {
            resolve(snapshotResult)
        } else {
            reject(snapshotResult)
        }
    })
}

async function startStreamingVideo() {
    console.log('starting video stream')
    clearFaceCanvas()
    page.videoElm.style.display = 'block'
    if (test) {
        console.log('testvideo')
        page.videoSourceElm.src = '/test-fail-vid-2.mov'
        page.videoElm.currentTime = 0
        page.videoElm.load()
        page.videoElm.play()
    }
}

async function stopStreamingVideo() {
    console.log('stopping video stream')
    page.videoElm.pause()
    page.videoElm.style.display = 'none'
}

async function playAuthInSound() {
    return new Promise(resolve => {
        page.authInSndElm.currentTime = 0
        page.authInSndElm.play()
        page.authInSndElm.addEventListener('ended', () => resolve('playAuthInSound done'))
    })
}

async function displayCountdown() {
    const soundMap = {
        5: page.fiveSndElm,
        4: page.fourSndElm,
        3: page.threeSndElm,
        2: page.twoSndElm,
        1: page.oneSndElm,
        0: page.zeroSndElm
    }

    return new Promise(async(resolve) => {
        let count = countdownSteps
        let countInterval
        hideAllTextElements()
        page.authenticateInElm.style.display = 'block'
        await playAuthInSound()

        const countF = () => {
            // show stuff
            if (count === 0) {
                clearInterval(countInterval)
                resolve('done counting')
            } else {
                page.countDown.innerHTML = `${count}`
                const countSound = soundMap[count]
                countSound.currentTime = 0
                countSound.play()
                count -= 1
            }

        }
        countInterval = setInterval(countF, 1000)
    })
}

/*
      return bytes of URL from canvas
    */
async function takeSnapshot() {
    return new Promise((resolve) => {
        const mainCanvasCtx = page.mainCanvas.getContext('2d')
        mainCanvasCtx.drawImage(page.videoElm, 0, 0, page.mainCanvas.width, page.mainCanvas.height)
        resolve(page.mainCanvas.toDataURL()) // TODO: the pic URL from canvas)
    })
}

async function playAnalyzingSound() {
    return new Promise((resolve) => {
        page.analyzingSndElm.currentTime = 0
        page.analyzingSndElm.play()
        page.analyzingSndElm.addEventListener('ended', () => resolve('playAnalyzingSound done'))
    })
}

/*
    call backend API that talks to amazon
*/
async function analyzeSnapshot(snapshotURL) {

    return new Promise(async(resolve, reject) => {
        // display analyzing
        hideAllTextElements()
        page.analyzingElm.style.display = 'block'
        await playAnalyzingSound()

        // POST snapshot to server
        fetch('/uploadSnapAndCompare', {
            method: 'POST',
            body: snapshotURL
        })
            .then(response => {
                if (response.ok) {
                    resolve(response.json())
                } else {
                    reject(response.json())
                }
            })
            .catch(err => {
                reject(err)
            })
    })
}

function clearFaceCanvas() {
    const faceGeoContext = page.faceGeoCanvas.getContext('2d')
    const mainCanvasContext = page.mainCanvas.getContext('2d')
    faceGeoContext.clearRect(0, 0, page.faceGeoCanvas.width, page.faceGeoCanvas.height)
    mainCanvasContext.clearRect(0, 0, page.mainCanvas.width, page.mainCanvas.height)
    page.textOnVideo.style.visibility = 'hidden'
}

async function drawFaceLandmarks(landmarks) {
    const faceGeoContext = page.faceGeoCanvas.getContext('2d');
    (landmarks || []).forEach(point => {
        let xCoord = Math.floor(point.X * page.stillImage.width)
        let yCoord = Math.floor(point.Y * page.stillImage.height)
        faceGeoContext.beginPath()
        faceGeoContext.arc(xCoord, yCoord, 2, 0, 2 * Math.PI, false)
        faceGeoContext.lineWidth = 2
        faceGeoContext.strokeStyle = '#00ff00'
        faceGeoContext.stroke()
    })
}

function addFaceStats(detectResult) {
    page.textOnVideo.style.visibility = 'visible'

    page.ageValueElm.innerHTML = `${detectResult.FaceDetails[0].AgeRange.Low} - ${detectResult.FaceDetails[0].AgeRange.High}`
    page.sexValueElm.innerHTML = `${detectResult.FaceDetails[0].Gender.Confidence.toFixed(1)}% ${detectResult.FaceDetails[0].Gender.Value}`
    page.beardValueElm.innerHTML = `${detectResult.FaceDetails[0].Beard.Confidence.toFixed(1)}% ${detectResult.FaceDetails[0].Beard.Value}`
    page.smileValueElm.innerHTML = `${detectResult.FaceDetails[0].Smile.Confidence.toFixed(1)}%  ${detectResult.FaceDetails[0].Smile.Value}`

    document.querySelectorAll('.dynamic').forEach(elm => {
        elm.remove()
    })

    detectResult.FaceDetails[0].Emotions.forEach(e => {
        const newLabel = document.createElement('div')
        newLabel.classList.add('label')
        newLabel.classList.add('dynamic')
        const cleanLabel = e.Type.toLowerCase().substr(0, 1).toUpperCase() + e.Type.toLowerCase().substr(1)
        newLabel.innerHTML = `${cleanLabel}:`
        page.faceStatsLabelBox.appendChild(newLabel)

        const newStat = document.createElement('div')
        newStat.classList.add('value')
        newStat.classList.add('dynamic')
        newStat.innerHTML = `${e.Confidence.toFixed(1)}%`
        page.faceStatsBox.appendChild(newStat)
    })

}

async function displaySnapshotResult(snapshotResult) {
    clearFaceCanvas()

    // in face comparison, you have matched faces and unmatched faces
    if (snapshotResult.compareResult.FaceMatches && snapshotResult.compareResult.FaceMatches.length > 0) {
        snapshotResult.compareResult.FaceMatches.forEach(matchedFace => {
            drawFaceLandmarks(matchedFace.Face.Landmarks)
        })
    }

    if (snapshotResult.compareResult.UnmatchedFaces && snapshotResult.compareResult.UnmatchedFaces.length > 0) {
        snapshotResult.compareResult.UnmatchedFaces.forEach(unmatchedFace => {
            drawFaceLandmarks(unmatchedFace.Landmarks)
        })
    }

    addFaceStats(snapshotResult.detectResult)
    if (snapshotResult.detectResult.FaceDetails && snapshotResult.detectResult.FaceDetails.length > 0) {
        drawFaceLandmarks(snapshotResult.detectResult.FaceDetails[0].Landmarks)
    }
}

/*
  Show auth success and play auth success sound
*/
async function displayAuthSuccess() {
    hideAllTextElements()
    page.authOKElm.style.display = 'block'
    page.authOKSndElm.currentTime = 0
    page.authOKSndElm.play()
}

/*
    Show auth failure message and play auth failure sound,
    backend handles sending notification

    it takes a second or so for the sound to play, so we'll resolve a promise
    here after the sound plays
*/
async function displayAuthFailure() {
    return new Promise((resolve) => {
        hideAllTextElements()
        page.authFailedElm.style.display = 'block'
        page.authFailedSndElm.currentTime = 0
        page.authFailedSndElm.play()
        page.authFailedSndElm.addEventListener('ended', () => resolve('displayAuthFailure done'))
    })
}

/*
    Called when the server sends us a sockio event for motion triggered
    The server keeps track of arming the motion alarm
*/
async function handleMotionActivation() {
    console.log('handling motion activation')
    try {
        console.log('awaiting authentication')
        await authenticate()
        // TODO should be more like ACCESS GRANTED here, because this is the FINAL
        // result of mulitple auth attempts, not just one attempt
        displayAuthSuccess()
    } catch (err) {
        console.log('auth exception', err)
    }
}

function testSimulateMotion() {
    handleMotionActivation()
}

function hideAllTextElements() {
    page.textElements.forEach(e => {
        e.style.display = 'none'
    })
}

function getPageElements() {
    const pageObj = {}
    pageObj.stillImage = document.querySelector('.still-image')
    pageObj.mainCanvas = document.querySelector('#mainCanvas')
    pageObj.snap = document.querySelector('#snap')
    pageObj.start = document.querySelector('#start')
    pageObj.countDown = document.querySelector('.count-down')
    pageObj.startCountdown = document.querySelector('#startCountdown')
    pageObj.authOKElm = document.querySelector('#authOK')
    pageObj.authenticateInElm = document.querySelector('#authenticateIn')
    pageObj.analyzingElm = document.querySelector('#analyzing')
    pageObj.authFailedElm = document.querySelector('#authFailed')
    pageObj.stillImageElm = document.querySelector('.still-image')
    pageObj.faceGeoCanvas = document.querySelector('#faceGeometry')
    pageObj.authInSndElm = document.querySelector('#authInSndElm')
    pageObj.fiveSndElm = document.querySelector('#fiveSndElm')
    pageObj.fourSndElm = document.querySelector('#fourSndElm')
    pageObj.threeSndElm = document.querySelector('#threeSndElm')
    pageObj.twoSndElm = document.querySelector('#twoSndElm')
    pageObj.oneSndElm = document.querySelector('#oneSndElm')
    pageObj.zeroSndElm = document.querySelector('#zeroSndElm')
    pageObj.analyzingSndElm = document.querySelector('#analyzingSndElm')
    pageObj.authFailedSndElm = document.querySelector('#authFailedSndElm')
    pageObj.authOKSndElm = document.querySelector('#authOKSndElm')
    pageObj.faceStatsLabelBox = document.querySelector('#faceStatsLabelBox')
    pageObj.faceStatsBox = document.querySelector('#faceStatsBox')
    pageObj.ageValueElm = document.querySelector('#ageValueElm')
    pageObj.sexValueElm = document.querySelector('#sexValueElm')
    pageObj.beardValueElm = document.querySelector('#beardValueElm')
    pageObj.smileValueElm = document.querySelector('#smileValueElm')
    pageObj.vidImageToggle = document.querySelector('#vidImageToggle')
    pageObj.showStillBtn = document.querySelector('#showStillBtn')
    pageObj.showVidBtn = document.querySelector('#showVidBtn')
    pageObj.textOnVideo = document.querySelector('#textOnVideo')
    pageObj.videoElm = document.querySelector('#mainVideo')
    pageObj.videoSourceElm = document.querySelector('#mainVideoSource')
    pageObj.textElements = [pageObj.authOKElm, pageObj.authenticateInElm, pageObj.analyzingElm, pageObj.authFailedElm]

    return pageObj
}

function handleSocketConnect(c) {
    console.log('socket connected', c)
}

window.onload = () => {
    init()
}
