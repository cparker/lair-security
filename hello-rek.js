'use strict'



const AWS = require('aws-sdk')
const rekognition = new AWS.Rekognition()
const fs = require('fs')

let picBuffer = fs.readFileSync('sample01.jpeg')

var params = {
  Image: { /* required */
    Bytes: picBuffer
  },
  Attributes: ["ALL"]
};

rekognition.detectFaces(params,  (err, data) => {
    if (err) console.log(err, err.stack) // an error occurred
    else     console.log(JSON.stringify(data, null, 2))           // successful response
});
