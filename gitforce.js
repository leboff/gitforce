/* exported tooling */
'use strict';

var nforce = require('nforce'),
  tooling = require('nforce-tooling')(nforce),
  octokit = require('octokit'),
  request = require('request'),
  q = require('q'),
  _ = require('lodash');

_.templateSettings.interpolate = /{\/([\s\S]+?)}/g;

var options = {
  headers :  {
    'User-Agent' : 'SFDC-Webhook-Receiver'
  }
};

var pathToType = {
	'classes':
		{
			name: 'ApexClass',
			member: 'ApexClassMember'
		}

};
var org, gh, token;

var apiUrl = function(url){
	return url.replace('github.com', 'api.github.com/repos');
};

var req = function(url, params){
	var deferred = q.defer();
  	options.url = url;
  	if(params){
  		options.qs = params;
  	}
  	request.get(options, function(error, response, body){
	    if (!error && response.statusCode === 200) {
	      deferred.resolve(body);
	    }
	    else{
	      console.log('error', response, url);
	      deferred.reject(error);
	    }
  	});
  	return deferred.promise;
};

var getBlob = function(file, blobs_url){
	var deferred = q.defer();

	options.url = _.template(blobs_url, {'sha': '/'+file.sha});
	options.qs = {access_token: token};
	request.get(options, function(error, response, body){
	    if (!error && response.statusCode === 200) {
	    	file.blob = JSON.parse(body);
	      	deferred.resolve(file);
	    }
	    else{
	      deferred.reject(error);
	    }
  	});
  	return deferred.promise;
};

var getFileBlobs = function(compare, blobs_url){
	var deferred = q.defer();
	compare = JSON.parse(compare);
		
	var blobs = [];
	_.each(compare.files, function(file){
		blobs.push(getBlob(file, blobs_url));
	});

	q.all(blobs)
	.then(function(data){
		deferred.resolve(data);
	})
	.fail(function(err){
		deferred.reject(err);
	});
	return deferred.promise;
};

var createContainer = function(){
	var deferred = q.defer();
	org.tooling.createContainer({name: 'webhook-container'}, function(err, resp){
		if(!err){
			deferred.resolve(resp.id);
		}
		else{
			if(err.errorCode === 'DUPLICATE_VALUE'){
				var patt = /id: ([a-zA-Z0-9]{15})/;
				var res = patt.exec(err.messageBody);
				console.log('duplicate container found, attempting to delete');
				if(res[1]){
					org.tooling.deleteContainer({id: res[1]}, function(err, resp){
						if(!err){
							createContainer().then(deferred.resolve);
						}
						else{
							console.log('Error', err);
							deferred.reject(err);
						}
					});
				}	
			}
			else{
				console.log(err);
				deferred.reject(err);
			}
		}
	});

	return deferred.promise;
};
var getFileType = function(filename){
	var path = filename.split('/');

	return pathToType[path[path.length-2]];
};
var getFileName = function(filename){
	var path = filename.split('/');
	var name = path[path.length-1].split('.');

	return name[0];
};
var getFileIds = function(compare){
	var deferreds = [];
	//create the object
	compare = JSON.parse(compare);
	var filesByType = _.groupBy(compare.files, function(file){
		return getFileType(file.filename).name;
	});

	_.each(filesByType, function(files, type){
		var filenames = _.pluck(files, 'filename'),
			querynames = _.map(filenames, getFileName).join('\',\''),
			query = 'select id, name from '+type+' where name in (\''+querynames+'\')';

		var deferred = q.defer();
		console.log(query);
		org.tooling.query({q: query}, function(err, resp){
			if(!err){
				deferred.resolve(resp.records);
			}
			else{
				console.log(err);
				deferred.reject(err);
			}
		});
		deferreds.push(deferred.promise);
	});

	return deferreds;
};
var addFilesToContainer = function(container_id, files){
	var deferreds = [];
	_.each(files, function(file){
		var body = new Buffer(file.blob.content, 'base64').toString('binary'),
			type = getFileType(file.filename).member,
			fact = { 
				body:body,
				contentEntityId: file.sfdc_id,
				metadataContainerId: container_id
			}

		var artifact = org.tooling.createDeployArtifact(getFileType(file.filename).member,fact);

		var deferred = q.defer();
		org.tooling.addContainerArtifact({id: container_id, artifact: artifact}, function(err, resp) {
			console.log(err, resp);
		  	if (err) deferred.reject(err);
		  	if (!err) deferred.resolve(resp);
		});
		deferreds.push(deferred.promise);
	});
	return q.all(deferreds);
}
var deploy = function(container_id){
	var deferred = q.defer();
	console.log('deploying');
	org.tooling.deployContainer({id: container_id, isCheckOnly: false}, function(err, resp){
		if(err) deferred.reject(err);
		if(!err) deferred.resolve(resp.id);
	});

 	return deferred.promise;
}
var getContainerStatus = function(deploy_id){
	var deferred = q.defer(),
		attempts = 1;

	var interval = setInterval(function(){
		console.log('checking container '+deploy_id+' status... attempt: '+attempts);
		org.tooling.getContainerDeployStatus({id: deploy_id}, function(err, resp){
			if(!err){
				console.log(resp.State);
				if(resp.State === 'Completed'){	
					clear(interval, deferred.resolve, resp);
				}
				else if(resp.State === 'Queued'){
				}
				else{
					clear(interval, deferred.reject, resp);
				}
			}
			else{
				clear(interval, deferred.reject, err);
			}
		});
		attempts++;
	}, 5000)
	
	var clear = function(interval, func, data){
		attempts = 0;
		clearInterval(interval);
		func(data);
	}

	return deferred.promise;
}


exports.config = function(sfdcConfig, githubToken, sfdcOauth){
	sfdcConfig.plugins = ['tooling'];
	sfdcConfig.apiVersion = 'v29.0';
	org = nforce.createConnection(sfdcConfig);
	
	org.authenticate(sfdcOauth, function(err, oauth){
		console.log(oauth);
	});

	gh = octokit.new({
		token: githubToken
	});

	token = githubToken;
};

exports.processPush = function(push){
	console.log('and watch works 2');
	var repo = gh.getRepo(push.repository.owner.name, push.repository.name);
	
	repo = push.repository;	
	//get the compare
	q.all([req(apiUrl(push.compare),{access_token: token}), createContainer()])
	.spread(function(compare, container_id){
		q.all([getFileBlobs(compare, repo.blobs_url)].concat(getFileIds(compare)))
		.spread(function(files, fileIds){
			//map ids to files
			console.log(files, fileIds);
			_.each(files, function(file){
				if(fileIds && fileIds.length > 0){
					var fileId = _.find(fileIds, {'Name' : getFileName(file.filename)});
					if(fileId){
						file.sfdc_id = fileId.Id;
					}
					else{
						file.sfdc_id = null;
					}
				}
				else{
					file.sfdc_id = null;
				}
			})
			
			return addFilesToContainer(container_id, files);
		})
		.then(function(){
			return deploy(container_id).then(getContainerStatus);
		})
		.then(console.log);
	})
	.fail(function(){
		console.log(err);
	});

};