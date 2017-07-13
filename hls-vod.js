var childProcess = require('child_process');
var http = require('http');
var https = require('https');
var url = require('url');
var fs = require('fs');
var path = require('path');
var readLine = require('readline');
var _ = require('underscore');

// 3rd party
var sanitize = require('validator').sanitize;
var wrench = require('wrench');
var express = require('express');
var serveStatic = require('serve-static');
var bodyParser = require('body-parser');
var socketIo = require('socket.io');

// Parameters
var listenPort = 4040;
var audioBitrate = 128;
var targetWidth = 640;
var targetQuality = 23
var searchPaths = [];
var rootPath = null;
var outputPath = './cache';
var transcoderPath = 'ffmpeg';
var probePath = 'ffprobe';
var debug = false;
var cert = null;
var key = null;
var videoExtensions = ['.mp4','.3gp2','.3gp','.3gpp', '.3gp2','.amv','.asf','.avs','.dat','.dv', '.dvr-ms','.f4v','.m1v','.m2p','.m2ts','.m2v', '.m4v','.mkv','.mod','.mp4','.mpe','.mpeg1', '.mpeg2','.divx','.mpeg4','.mpv','.mts','.mxf', '.nsv','.ogg','.ogm','.mov','.qt','.rv','.tod', '.trp','.tp','.vob','.vro','.wmv','.web,', '.rmvb', '.rm','.ogv','.mpg', '.avi', '.mkv', '.wmv', '.asf', '.m4v', '.flv', '.mpg', '.mpeg', '.mov', '.vob', '.ts', '.webm'];
var audioExtensions = ['.mp3', '.aac', '.m4a'];
var imageExtensions = ['.jpg', '.png', '.bmp', '.jpeg', '.gif'];
var io = null;

function convertSecToTime(sec){
	var date = new Date(null);
	date.setSeconds(sec);
	var result = date.toISOString().substr(11, 8);
	var tmp=(sec+"").split('.');
	if(tmp.length == 2){
		result+='.' + tmp[1];
	}
	return result;
}

function startTranscoding(file, offset, speed, info, socket){
	var atempo = [];
	var setpts = 1.0;
	var fps = 30;
	switch(speed) {
		case 4:
			atempo.push('atempo=2');
			setpts = setpts / 2;
		case 3:
			atempo.push('atempo=2');
			setpts = setpts / 2;
		case 2:
			atempo.push('atempo=2');
			setpts = setpts / 2;
		case 1:
			atempo.push('atempo=2');
			setpts = setpts / 2;
			fps *= 2;
			break;
		default:
			break;
	}

	switch(targetWidth) {
	case 240:
		audioBitrate = 32;
		fps = 25;
		break;
	case 320:
		audioBitrate = 64;
		break;
	default:
		audioBitrate = 128;
		break;
	}
	var atempo_opt = atempo.length ? atempo.join(',') : 'anull';
	var setpts_opt = setpts.toFixed(4);
	var startTime = convertSecToTime(offset);
	var gop = fps;
	var seq = 0;
	var ack = 0;
	var pause = false;
	var args = [
		'-ss', startTime,
		'-i', file, '-sn', '-async', '0',
		'-af', atempo_opt,
		'-acodec', 'aac', '-b:a', audioBitrate + 'k', '-ar', '44100', '-ac', '2',
		'-vf', 'scale=min(' + targetWidth + '\\, iw):-2,setpts=' + setpts_opt + '*PTS', '-r',  fps,
		'-vcodec', 'libx264', '-profile:v', 'baseline', '-preset:v', 'ultrafast', '-tune', 'zerolatency', '-crf', targetQuality, '-g', gop,
		'-x264opts', 'level=3.0', '-pix_fmt', 'yuv420p',
		'-threads', '0', '-flags', '+global_header', '-map', '0', /*'-v', 'error',*/
		'-f', 'mp4', '-reset_timestamps', '1', '-movflags', 'empty_moov+frag_keyframe+default_base_moof', 'pipe:1'
	];
	var encoderChild = childProcess.spawn(transcoderPath, args, {env: process.env});

	console.log('[' + socket.id + '] Spawned encoder instance');
	
	if (debug)
		console.log(transcoderPath + ' ' + args.join(' '));

	stop = function(){
		if (!pause) {
			pause = true;
			if (debug)
				console.log('pause');
			encoderChild.kill('SIGSTOP');
		}
	}

	start = function(){
		if (pause) {
			pause = false;
			if (debug)
				console.log('continue');
			encoderChild.kill('SIGCONT');
		}
	}

	quit = function(){
		start();
		encoderChild.kill();
		setTimeout(function() {
			encoderChild.kill('SIGKILL');
		}, 5000);
	}
	
	check_ack = function(){
		var wait = seq - ack > 100 ? true : false;
		if (wait && !pause) {
			stop();
		} else if (!wait && pause) {
			start();
		}
	}

	var re = /frame=\s*(\d*).*fps=(\d*).*q=([\d\.]*).*size=\s*(\d*kB).*time=([\d\.\:]*).*bitrate=\s*([\d\.]*\S*).*speed=([\d\.x]*)/i;
	encoderChild.stderr.on('data', function(data) {
		if (debug)
			console.log(data.toString());
		var match = data.toString().match(re);
		if (match && match.length == 8) {
			var verbose = {};
			verbose['frame'] = match[1];
			verbose['fps'] = match[2];
			verbose['q'] = match[3];
			verbose['size'] = match[4];
			verbose['time'] = match[5];
			verbose['bitrate'] = match[6];
			verbose['speed'] = match[7];
			socket.emit('verbose', verbose);
			if (debug)
				console.log('[' + socket.id + '] seq: ' + seq + ' ack: ' + ack);
		}
	});
	
	encoderChild.stdout.on('data', function(data) {
		if (debug) {
			console.log(data.length);
		}
		socket.emit('data', {seq : seq++, buffer : data});
		check_ack();
	});
	
	encoderChild.on('exit', function(code) {
		if (code == 0) {
			socket.emit('eos');
			console.log('[' + socket.id + '] Encoder completed');
		} else {
			console.log('[' + socket.id + '] Encoder exited with code ' + code);
		}
	});

	socket.on('ack',function(data){
		ack = data;
		check_ack();
	});

	socket.on('disconnect', function(){
		console.log('[' + socket.id + '] Disconnect');
		quit();
	});

	socket.on('error', function(){
		console.log('[' + socket.id + '] Error')
		quit();
	});

	socket.on('pause', function(){
		stop();
	});
	
	socket.on('continue', function(){
		start();
	});

}

function handleMp4Request(file, offset, speed, socket){
	if (debug)
		console.log('MP4 request: ' + file)

	if (file) {
		file = path.join('/', file);
		file = path.join(rootPath, file);

		var args = [
			'-v', '0', '-print_format', 'json', '-show_format', '-show_streams', file
		];
		var probeChild = childProcess.spawnSync(probePath, args);
		var json = probeChild.stdout.toString();
		try {
			var info = JSON.parse(json);
			socket.emit('mediainfo', info);
			startTranscoding(file, offset, speed, info, socket);
		} catch (err) {
			console.log('[' + socket.id + '] ' + json);
		}
/*
		var probeChild = childProcess.spawn(probePath, args, {env: process.env});
		var json = '';

		probeChild.stderr.on('data', function(data) {
			console.log(data.toString());
		});

		probeChild.stdout.on('data', function(data) {
			if (debug)
				console.log(data.toString());
			json += data.toString();
		});

		probeChild.stdout.on('close', function() {
			try {
				var info = JSON.parse(json);
				socket.emit('mediainfo', info);
				startTranscoding(file, offset, speed, info, socket);
			} catch (err) {
				console.log('[' + socket.id + '] ' + json);
			}
		});
*/

	}

}

function listFiles(response) {
	var searchRegex = '(' + videoExtensions.join('|') + ')$';

	if (searchPaths.length === 0) response.end();

	searchPaths.forEach(function(searchPath) {
		wrench.readdirRecursive(searchPath, function(err, curFiles) {
			if (err) {
				console.log(err);
				return;
			}
			if (curFiles == null) {
				response.end(); // No more files
				return;
			}

			curFiles.forEach(function(filePath) {
				filePath = path.join(path.relative(rootPath, searchPath), filePath);
				if (filePath.match(searchRegex)) {
					var friendlyName = filePath;
					var matches = friendlyName.match(/\/?([^/]+)\.[a-z0-9]+$/);
					if (matches && matches.length == 2) {
						friendlyName = matches[1];
					}

					response.write(
						'<a href="/hls/file-' + encodeURIComponent(filePath) + '.m3u8' + '" title="' + sanitize(filePath).entityEncode() + '">'
						+ sanitize(friendlyName).entityEncode() + '</a>'
						+ ' (' + sanitize(path.extname(filePath)).entityEncode() + ')'
						+ ' (<a href="' + sanitize(path.join('/raw', filePath)).entityEncode() + '">Raw</a>)<br />');
				}
			});
		});
	});
}


function browseDir(browsePath, response) {
	browsePath = path.join('/', browsePath); // Remove ".." etc
	fsBrowsePath = path.join(rootPath, browsePath);

	var fileList = [];

	fs.readdir(fsBrowsePath, function(err, files) {
		if (err) {
			response.writeHead(500);
			response.end();
			console.log('Failed to read directory, ' + err);
			return;
		}

		var filesDone = 0;
		function fileDone() {
			filesDone++;

			if (filesDone == files.length) {
				fileList.sort(function(a, b) {
					return a.name.localeCompare(b.name);
				});
				response.json({
					cwd: browsePath,
					files: fileList
				});
				response.end();
			}
		}

		if (files.length === 0) {
			filesDone--;
			fileDone();
		}
		else {
			files.forEach(function(file) {
				var fsPath = path.join(fsBrowsePath, file);
				fs.lstat(fsPath, function(err, stats) {
					var fileObj = {};

					fileObj.name = file;

					if (err) {
						fileObj.error = true;
						fileObj.errorMsg = err;
					}
					else if (stats.isFile()) {
						var relPath = path.join(browsePath, file);
						var extName = path.extname(file).toLowerCase();
						if (videoExtensions.indexOf(extName) != -1) {
							fileObj.type = 'video';
							fileObj.path = encodeURIComponent(relPath) + '.mp4';
						}
						else if (audioExtensions.indexOf(extName) != -1) {
							fileObj.type = 'audio';
							fileObj.path = path.join('/audio/' + encodeURIComponent(relPath));
						}
						else if (imageExtensions.indexOf(extName) != -1) {
							relPath = Buffer.from(relPath).toString('base64');
							fileObj.type = 'image';
							fileObj.path = path.join('/image/' + encodeURIComponent(relPath));
						}

						fileObj.relPath = path.join('/', relPath);
					}
					else if (stats.isDirectory()) {
						fileObj.type = 'directory';
						fileObj.path = path.join(browsePath, file);
					}

					fileList.push(fileObj);

					fileDone();
				});
			});
		}
	});
}

function handleThumbnailRequest(file, response) {
	file = path.join('/', file);
	var fsPath = path.join(rootPath, file);

	// http://superuser.com/questions/538112/meaningful-thumbnails-for-a-video-using-ffmpeg
	//var args = ['-ss', '00:00:20', '-i', fsPath, '-vf', 'select=gt(scene\,0.4)', '-vf', 'scale=iw/2:-1,crop=iw:iw/2', '-f', 'image2pipe', '-vframes', '1', '-'];
	var args = ['-ss', '00:00:20', '-i', fsPath, '-vf', 'select=eq(pict_type\\,PICT_TYPE_I),scale=min(640\\,iw):-2,tile=2x2', '-f', 'image2pipe', '-vframes', '1', '-'];

	if (debug) console.log('Spawning thumb process');

	var child = childProcess.spawn(transcoderPath, args, {cwd: outputPath, env: process.env});

	if (debug) {
		child.stderr.on('data', function(data) {
			console.log(data.toString());
		});
	}
	response.setHeader('Content-Type', 'image/jpeg');
	child.stdout.pipe(response);

	child.on('exit', function(code) {
		response.end();
	});

	setTimeout(function() {
		child.kill('SIGKILL');
	}, 10000);
}


// Problem: some clients interrupt the HTTP request and send a new one, causing the song to restart...
function handleAudioRequest(relPath, request, response) {
	var file = path.join('/', relPath);
	var filePath = path.join(rootPath, file);
	var headerSent = false;

	// TODO: Child management
	var encoderChild = childProcess.spawn(transcoderPath, [
		'-i', filePath, '-threads', '0',
		'-b:a', 192 + 'k', '-ac', '2', '-acodec', 'libmp3lame',
		'-map', '0:a:0',
		'-f', 'mp3', '-'
	]);

	if (debug) {
		encoderChild.stderr.on('data', function(data) {
			console.log(data.toString());
		});
	}

	encoderChild.stdout.on('data', function() {
		if (!headerSent) {
			response.writeHead(200, {'Content-Type': 'audio/mpeg'});
			headerSent = true;
		}
	});

	request.on('close', function() {
		encoderChild.kill();
		setTimeout(function() {
			encoderChild.kill('SIGKILL');
		}, 5000);
	});

	encoderChild.stdout.pipe(response);
}

function handleImageRequest(relPath, request, response) {
	var file = path.join('/', relPath);
	var filePath = path.join(rootPath, file);
	var readStream = fs.createReadStream(filePath);
	response.writeHead(200);
	readStream.pipe(response);
}


function init() {
	function exitWithUsage(argv) {
		console.log(
			'Usage: ' + argv[0] + ' ' + argv[1]
			+ ' --root-path PATH'
			+ ' [--search-path PATH1 [--search-path PATH2 [...]]]'
			+ ' [--port PORT]'
			+ ' [--transcoder-path PATH]'
			+ ' [--debug]'
		);
		process.exit();
	}

	for (var i=2; i<process.argv.length; i++) {
		switch (process.argv[i]) {
			case '--transcoder-path':
			if (process.argv.length <= i+1) {
				exitWithUsage(process.argv);
			}
			transcoderPath = process.argv[++i];
			console.log('Transcoder path ' + transcoderPath);
			break;

			case '--root-path':
			if (process.argv.length <= i+1) {
				exitWithUsage(process.argv);
			}
			rootPath = process.argv[++i];
			break;

			case '--search-path':
			if (process.argv.length <= i+1) {
				exitWithUsage(process.argv);
			}
			searchPaths.push(process.argv[++i]);
			break;

			case '--port':
			if (process.argv.length <= i+1) {
				exitWithUsage(process.argv);
			}
			listenPort = parseInt(process.argv[++i]);
			break;

			case '--cert':
			if (process.argv.length <= i+1) {
				exitWithUsage(process.argv);
			}
			cert = process.argv[++i];
			break;

			case '--key':
			if (process.argv.length <= i+1) {
				exitWithUsage(process.argv);
			}
			key = process.argv[++i];
			break;
			
			case '--debug':
				debug = true;
			break;

			default:
			console.log(process.argv[i]);
			exitWithUsage(process.argv);
			break;
		}
	}
	
	console.log(rootPath + ' ' + searchPaths);

	if (!rootPath) {
		exitWithUsage(process.argv);
	}

	initExpress();
}

function initExpress() {
	var app = express();
	var server;
	if (cert && key)
	{
		var options = {
			key: fs.readFileSync(key),
			cert: fs.readFileSync(cert)
		};
		server = https.createServer(options, app);
	} else {
		server = http.createServer(app);
	}
	
	io = socketIo(server);

	app.use(bodyParser.urlencoded({extended: false}));

	app.all('*', function(request, response, next) {
		console.log(request.url);
		next();
	});

	app.use('/', serveStatic(__dirname + '/static'));

	app.get(/^\/thumbnail\//, function(request, response) {
		var file = path.relative('/thumbnail/', decodeURIComponent(request.path));
		handleThumbnailRequest(file, response);
	});

	app.get('/list', function(request, response) {
		listFiles(response);
	});

	app.get(/^\/browse/, function(request, response) {
		var browsePath = path.relative('/browse', decodeURIComponent(request.path));
		browseDir(browsePath, response);
	});

	app.use('/raw/', serveStatic(rootPath));

	app.get(/^\/del/, function(request, response){
		var relPath = path.relative('/del/', decodeURIComponent(request.path));
		console.log(relPath);
		response.writeHead(200);
		response.end();
	});

	app.get(/^\/audio\//, function(request, response) {
		var relPath = path.relative('/audio/', decodeURIComponent(request.path));
		handleAudioRequest(relPath, request, response);
	});

	app.get(/^\/image\//, function(request, response) {
		var relPath = path.relative('/image/', decodeURIComponent(request.path));
		relPath = Buffer.from(relPath, 'base64').toString('utf8');
		handleImageRequest(relPath, request, response);
	});
		
	app.post(/^\/settings/, function(request, response) {
		console.log(request.body);

		var newWidth = request.body.videoWidth;
		var newQuality = request.body.videoQuality;
		if (newWidth) {
			targetWidth = parseInt(newWidth);
		}
		if (newQuality) {
			targetQuality = parseInt(newQuality);
		}

		response.end();
	});

	app.get(/^\/settings/, function(request, response) {
		response.setHeader('Content-Type', 'application/json');
		response.write(JSON.stringify({
			'videoWidth': targetWidth,
			'videoQuality': targetQuality
		}));
		response.end();
	});
	
	io.on('connection', function (socket) {
		socket.on('start', function (data) {
			if (debug)
				console.log(socket.id);
			var match = /^(.+).mp4/.exec(data.file);
			if (match) {
				handleMp4Request(decodeURIComponent(match[1]), data.offset, data.speed, socket);
			}
		});
	});

	server.listen(listenPort);
}


init();
