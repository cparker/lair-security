"use strict";

const util      = require('util');
const spawn     = require('child_process').spawn;
const merge     = require('mout/object/merge');

const Server    = require('./_server');

let streamer


class RpiServer extends Server {

  constructor(server, opts) {
    console.log('const opts', opts)
    super(server, merge({
      fps : 12,
    }, opts));
  }

  get_feed() {
    console.log(`raspivid -n -t 0 -o - -w ${this.options.width} -h ${this.options.height} -fps ${this.options.fps} -pf baseline`);
   // var streamer = spawn('raspivid', ['-n','-md','4', '-t', '0', '-o', '-', '-w', this.options.width, '-h', this.options.height, '-fps', this.options.fps, '-pf', 'baseline', '-rot', this.options.rotation]);
    streamer = spawn('raspivid', ['-n','-md','4', '-t', '0', '-o', '-', '-w', this.options.width, '-fps', this.options.fps, '-pf', 'baseline', '-rot', this.options.rotation]);
    streamer.on("error", e => {
      console.log('child proc error event', e)
    })
    
    streamer.on("exit", function(code){
      console.log("Failure", code);
    });

    return streamer.stdout;
  }

  kill_feed() {
    console.log('killing')
    try {
      streamer.kill('SIGKILL')
    } catch (err) {
      console.log('ignoring error sending kill', err)
    }

  }

};



module.exports = RpiServer;
