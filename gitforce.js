/* exported tooling */
'use strict';

var nforce = require('nforce'),
  tooling = require('nforce-tooling')(nforce),
  request = require('request'),
  q = require('q'),
  _ = require('lodash');

_.templateSettings.interpolate = /{\/([\s\S]+?)}/g;




function GitForce(sfdcConfig, githubToken){
	sfdcConfig.plugins = ['tooling'];

	var org = nforce.createConnection(sfdcConfig),
		github_token = githubToken,
		options = {
		  headers :  {
		    'User-Agent' : 'SFDC-Webhook-Receiver'
		  }
		},
		pathToType = {
			'classes':
				{
					name: 'ApexClass',
					member: 'ApexClassMember',
					ext: 'cls'
				}
		};


	var apiUrl = function(repo, head_commit, last_commit){
		if(last_commit){
			return repo.compare_url.replace('{base}', last_commit).replace('{head}', head_commit);
		}
		else{
			return repo.commits_url.replace('{/sha}', '/'+head_commit);
		}
		
	};

	var getCompare = function(repo, head_commit, last_commit){
		var deferred = q.defer();
	  	options.url = apiUrl(repo, head_commit, last_commit);
		options.qs = {access_token: github_token};
	  	request.get(options, function(error, response, body){
		    if (!error && response.statusCode === 200) {
		      deferred.resolve(JSON.parse(body));
		    }
		    else{
		      console.log('error', response, options.url);
		      deferred.reject(error);
		    }
	  	});
	  	return deferred.promise;
	};

	var getBlob = function(file, blobs_url){
		var deferred = q.defer();

		options.url = _.template(blobs_url, {'sha': '/'+file.sha});
		options.qs = {access_token: github_token};
		request.get(options, function(error, response, body){
		    if (!error && response.statusCode === 200) {
		    	file.blob = JSON.parse(body);
		      	deferred.resolve(file);
		    }
		    else{
		    	console.log(error);
		      deferred.reject(error);
		    }
	  	});
	  	return deferred.promise;
	};

	var getFileBlobs = function(compareFiles, blobs_url){
		var deferred = q.defer();
		var blobs = [];
		_.each(compareFiles, function(file){
			if(getFileType(file.filename))
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
					if(res[1]){
						org.tooling.deleteContainer({id: res[1]}, function(err, resp){
							if(!err){
								createContainer().then(deferred.resolve);
							}
							else{
								deferred.reject(err);
							}
						});
					}	
				}
				else{
					deferred.reject(err);
				}
			}
		});

		return deferred.promise;
		};
	var getFileType = function(filename){
		var path = filename.split('/'),
			extension = filename.split('.'),
			type = pathToType[path[path.length-2]];

		if(_.last(extension) === type.ext){
			return type;
		}
		
	};
	var getFileName = function(filename){
		var path = filename.split('/');
		var name = _.last(path).split('.');
		return name[0];
	};
	var getFileIds = function(compareFiles){
		var deferreds = [];
		//create the object

		var filesByType = _.groupBy(compareFiles, function(file){
			var type = getFileType(file.filename);
			return type ? type.name : null;
		});


		_.each(filesByType, function(files, type){
			if(type !== 'null'){
				var filenames = _.pluck(files, 'filename'),
				querynames = _.map(filenames, getFileName).join('\',\''),
				query = 'select id, name from '+type+' where name in (\''+querynames+'\')',
				deferred = q.defer();

				org.tooling.query({q: query}, function(err, resp){
					if(!err){
						deferred.resolve(resp.records);
					}
					else{
						deferred.reject(err);
					}
				});
				deferreds.push(deferred.promise);
			}
			
		});

		return deferreds;
	};

	var createFile = function(file){
		var deferred = q.defer();


		var sobj = nforce.createSObject(getFileType(file.filename).name);
		sobj.set('Name', getFileName(file.filename));
		sobj.set('Body', 'public class '+getFileName(file.filename)+'{}');


		org.insert({sobject: sobj}, function(err, resp){
			
			if(err)deferred.reject(err);
			if(!err)deferred.resolve(resp);
		});

		return deferred.promise;
	}

	var addFileToContainer = function(container_id, file){
		var deferred = q.defer(),
			body = new Buffer(file.blob.content, 'base64').toString('binary'),
			type = getFileType(file.filename).member,
			fact = {
				body:body,
				contentEntityId: file.sfdc_id,
				metadataContainerId: container_id
			},
			artifact = org.tooling.createDeployArtifact(getFileType(file.filename).member,fact);

		org.tooling.addContainerArtifact({id: container_id, artifact: artifact}, function(err, resp) {
		  	if (err) deferred.reject(err);
		  	if (!err) deferred.resolve(resp);
		});

		return deferred.promise;
	}
	var addFilesToContainer = function(container_id, files){
		var deferreds = [];
		_.each(files, function(file){

			if(file.sfdc_id === null){
				var createDeferred = q.defer();
				createFile(file).then(function(result){
					file.sfdc_id = result.id;
					addFileToContainer(container_id, file).then(createDeferred.resolve);
				});
				deferreds.push(createDeferred.promise);
			}
			else{
				deferreds.push(addFileToContainer(container_id, file));
			}

		});
		return q.all(deferreds);
	}
	var deploy = function(container_id){
		var deferred = q.defer();
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
			org.tooling.getContainerDeployStatus({id: deploy_id}, function(err, resp){
				if(!err){
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
	this.processPush = function(push, last_commit){
		var deferred = q.defer();
		var repo = push.repository;	
		//get the compare
		q.all([getCompare(repo, push.head_commit.id, last_commit), createContainer()])
		.spread(function(compare, container_id){
			q.all([getFileBlobs(compare.files, repo.blobs_url)].concat(getFileIds(compare.files)))
			.spread(function(files, fileIds){
				//map ids to files
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
			.then(function(){
				deferred.resolve(repo.head_commit.id);
			});
		})
		.fail(deferred.reject);

		return deferred.promise;
	};

}


module.exports = GitForce;