let io
let stillImage
let snap, start
let mySocket
let mainCanvas
let countDown
let startCountdown
let authOKElm, authenticateInElm, analyzingElm, authFailedElm, vidImageToggle
let stillImageElm
let showVid = true
let faceGeoCanvas, faceGeoContext
let authInSndElm, fiveSndElm, fourSndElm, threeSndElm, twoSndElm, oneSndElm, zeroSndElm, analyzingSndElm, authFailedSndElm, authOKSndElm
let ageValueElm, sexValueElm, beardValueElm, smileValueElm
let faceStatsBox, faceStatsLabelBox, textOnVideo
let showStillBtn, showVidBtn
let videoPlayer
let authFailedCount

const imageWidth = 1280
const imageHeight = 768

const matchThreshold = 80

function init() {
    stillImage = document.querySelector('.still-image')
    mainCanvas = document.querySelector('#mainCanvas')
    snap = document.querySelector('#snap')
    start = document.querySelector('#start')
    mySocket = io('/fred', {
        path: '/mystuff'
    }).connect()
    countDown = document.querySelector('.count-down')
    startCountdown = document.querySelector('#startCountdown')
    authOKElm = document.querySelector('#authOK')
    authenticateInElm = document.querySelector('#authenticateIn')
    analyzingElm = document.querySelector('#analyzing')
    authFailedElm = document.querySelector('#authFailed')
    stillImageElm = document.querySelector('.still-image')
    faceGeoCanvas = document.querySelector('#faceGeometry')

    authInSndElm = document.querySelector('#authInSndElm')
    fiveSndElm = document.querySelector('#fiveSndElm')
    fourSndElm = document.querySelector('#fourSndElm')
    threeSndElm = document.querySelector('#threeSndElm')
    twoSndElm = document.querySelector('#twoSndElm')
    oneSndElm = document.querySelector('#oneSndElm')
    zeroSndElm = document.querySelector('#zeroSndElm')
    analyzingSndElm = document.querySelector('#analyzingSndElm')
    authFailedSndElm = document.querySelector('#authFailedSndElm')
    authOKSndElm = document.querySelector('#authOKSndElm')

    faceStatsLabelBox = document.querySelector('#faceStatsLabelBox')
    faceStatsBox = document.querySelector('#faceStatsBox')
    ageValueElm = document.querySelector('#ageValueElm')
    sexValueElm = document.querySelector('#sexValueElm')
    beardValueElm = document.querySelector('#beardValueElm')
    smileValueElm = document.querySelector('#smileValueElm')
    vidImageToggle = document.querySelector('#vidImageToggle')

    showStillBtn = document.querySelector('#showStillBtn')
    showVidBtn = document.querySelector('#showVidBtn')

    textOnVideo = document.querySelector('#textOnVideo')

    const textElements = [authOKElm, authenticateInElm, analyzingElm, authFailedElm]

    const soundMap = {
        5: fiveSndElm,
        4: fourSndElm,
        3: threeSndElm,
        2: twoSndElm,
        1: oneSndElm,
        0: zeroSndElm
    }

    mainCanvas.width = imageWidth
    mainCanvas.height = imageHeight

    faceGeoCanvas.width = imageWidth
    faceGeoCanvas.height = imageHeight

    const authOK = () => {
        textElements.forEach(e => {
            e.style.display = 'none'
        })
        authOKElm.style.display = 'block'
        authOKSndElm.currentTime = 0
        authOKSndElm.play()
    }

    const authenticateIn = () => {
        textElements.forEach(e => {
            e.style.display = 'none'
        })
        authenticateInElm.style.display = 'block'
        authInSndElm.currentTime = 0
        authInSndElm.play()
    }

    function uploadSnapAndCompare(url) {
        return fetch('/uploadSnapAndCompare', {
            method: 'POST',
            body: url
        })
    }

    function takeSnapAndCompare() {
        let picURL = mainCanvas.toDataURL()
        stillImageElm.src = picURL

        displayStillImage()
        videoPlayer.stopStream()
        analyzing()
        uploadSnapAndCompare(picURL)
            .then(result => {
                console.log('uploaded snap returned')
                return result.json()
            })
            .then(data => {
                console.log('uploadSnapCompareResponseData', data)
                if (data.FaceMatches && data.FaceMatches.length > 0 && data.FaceMatches[0].Similarity >= matchThreshold) {
                    authOK()
                } else {
                    authFailed()
                }

                // handle exception of drawing face geo separately so it doesn't trigger authfailed state
                try {
                    if (data.FaceMatches && data.FaceMatches.length > 0) {
                        data.FaceMatches.forEach(mf => {
                            drawFaceLandmarks(mf.Face.Landmarks)
                        })
                    }
                    if (data.UnmatchedFaces && data.UnmatchedFaces.length > 0) {
                        data.UnmatchedFaces.forEach(uf => {
                            drawFaceLandmarks(uf.Landmarks)
                        })
                    }
                } catch (err) {
                    console.log('caught error drawing face landmarks', err)
                }

            })
            .catch(err => {
                console.log('error uploading snapshot', err)
                authFailed()
            })
            .finally(() => {
                if (authFailedCount)
            })
    }

    function analyzing() {
        textElements.forEach(e => {
            e.style.display = 'none'
        })
        analyzingElm.style.display = 'block'
        analyzingSndElm.currentTime = 0
        analyzingSndElm.play()
    }

    function authFailed() {
        authFailedCount += 1
        textElements.forEach(e => {
            e.style.display = 'none'
        })
        authFailedElm.style.display = 'block'
        authFailedSndElm.currentTime = 0
        authFailedSndElm.play()
    }

    snap.addEventListener('click', () => {
        console.log('snappy, take picture of canvas')
        let picURL = mainCanvas.toDataURL()
        fetch('/savepic', {
            method: 'POST',
            body: picURL
        })
    })

    start.addEventListener('click', () => {
        console.log('start')
        videoPlayer.playStream()
    })

    function authCountdown() {
        authenticateIn()
        let count = 5
        const countInterval = setInterval(() => {
            if (count < 0) {
                clearInterval(countInterval)
                takeSnapAndCompare()
            } else {
                countDown.innerHTML = `${count}`
                const countSound = soundMap[count]
                countSound.currentTime = 0
                countSound.play()
                count -= 1
            }
        }, 1000)
    }

    startCountdown.addEventListener('click', () => {
        authCountdown()
    })

    authFailedElm.addEventListener('click', () => {
        handleMotionAlarm()
    })

    function displayMain() {
        mainCanvas.style.display = 'block'
        stillImageElm.style.display = 'none'
    }

    function displayStillImage() {
        mainCanvas.style.display = 'none'
        stillImageElm.style.display = 'block'
    }

    vidImageToggle.addEventListener('click', () => {
        if (showVid) {
            mainCanvas.style.display = 'none'
            stillImageElm.style.display = 'block'
            showVid = false
        } else {
            mainCanvas.style.display = 'block'
            stillImageElm.style.display = 'none'
            showVid = true
        }
    })

    function handleMotionAlarm() {
        displayMain()
        videoPlayer.playStream()
        authCountdown()
    }

    // Create h264 player
    let uri = `ws://${document.location.host}/video`
    console.log(`ws uri is ${uri}`)
    videoPlayer = new WSAvcPlayer(mainCanvas, 'webgl', 1, 35)
    videoPlayer.connect(uri)

    // SOCKET EvENTS
    mySocket.on('connect', c => {
        console.log('connected', c)
    })

    mySocket.on('test', d => {
        console.log('got a test event', d)
    })

    mySocket.on('motionAlarm', m => {
        console.log('motion alarm')
        handleMotionAlarm()
    })

    showVidBtn.addEventListener('click', () => {
        console.log('showing vid')
        videoPlayer.playStream()
    })

    showStillBtn.addEventListener('click', () => {
        console.log('showing still')
        videoPlayer.stopStream()
    })

}

function drawFaceLandmarks(landmarks) {
    faceGeoContext = faceGeoCanvas.getContext('2d')
    console.log('stillImage dims', stillImage.width, stillImage.height)
    landmarks.forEach(point => { // first face
        let xCoord = Math.floor(point.X * stillImage.width)
        let yCoord = Math.floor(point.Y * stillImage.height)
        faceGeoContext.beginPath()
        faceGeoContext.arc(xCoord, yCoord, 2, 0, 2 * Math.PI, false)
        faceGeoContext.lineWidth = 2
        faceGeoContext.strokeStyle = '#00ff00'
        faceGeoContext.stroke()
    })
}

function addFaceStats() {
    textOnVideo.style.visibility = 'visible'

    ageValueElm.innerHTML = `${testFaceData.FaceDetails[0].AgeRange.Low} - ${testFaceData.FaceDetails[0].AgeRange.High}`
    sexValueElm.innerHTML = `${testFaceData.FaceDetails[0].Gender.Confidence.toFixed(1)}% ${testFaceData.FaceDetails[0].Gender.Value}`
    beardValueElm.innerHTML = `${testFaceData.FaceDetails[0].Beard.Confidence.toFixed(1)}% ${testFaceData.FaceDetails[0].Beard.Value}`
    smileValueElm.innerHTML = `${testFaceData.FaceDetails[0].Smile.Confidence.toFixed(1)}%  ${testFaceData.FaceDetails[0].Smile.Value}`
    testFaceData.FaceDetails[0].Emotions.forEach(e => {
        const newLabel = document.createElement('div')
        newLabel.classList.add('label')
        const cleanLabel = e.Type.toLowerCase().substr(0, 1).toUpperCase() + e.Type.toLowerCase().substr(1)
        newLabel.innerHTML = `${cleanLabel}:`
        faceStatsLabelBox.appendChild(newLabel)

        const newStat = document.createElement('div')
        newStat.classList.add('value')
        newStat.innerHTML = `${e.Confidence.toFixed(1)}%`
        faceStatsBox.appendChild(newStat)
    })
}

window.onload = () => {
    console.log('onload')
    init()
}