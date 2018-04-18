import subprocess # for piping
from BaseHTTPServer import HTTPServer, BaseHTTPRequestHandler

class RequestHandler(BaseHTTPRequestHandler):
    def _writeheaders(self):
        self.send_response(200) # 200 OK http response
        self.send_header('Content-type', 'video/mp4')
        self.end_headers()

    def do_HEAD(self):
        self._writeheaders()

    def do_GET(self):
        self._writeheaders()

        DataChunkSize = 10000

        command = '(echo "--video boundary--"; raspivid --rotation 90 -w 1024 -h 576 -fps 30 -pf baseline -n -t 0 -o -;) | gst-launch-1.0 -e -q fdsrc fd=0 ! video/x-h264,width=1024,height=576,framerate=30/1,stream-format=byte-stream ! h264parse ! mp4mux streamable=true fragment-duration=10 presentation-time=true ! filesink location=/dev/stdout'
        print("running command: %s" % (command, ))
        p = subprocess.Popen(command, stdout=subprocess.PIPE, bufsize=-1, shell=True)

        print("starting polling loop.")
        while(p.poll() is None):
            print "looping... "
            stdoutdata = p.stdout.read(DataChunkSize)
            self.wfile.write(stdoutdata)

        print("Done Looping")

        print("dumping last data, if any")
        stdoutdata = p.stdout.read(DataChunkSize)
        self.wfile.write(stdoutdata)

if __name__ == '__main__':
    serveraddr = ('', 8765) # connect to port 8765
    srvr = HTTPServer(serveraddr, RequestHandler)
    srvr.serve_forever()
