var  q = require('q'),
  request = require('request'),
  nforce = require("nforce"),
  _ = require('lodash'),
  tooling = require('nforce-tooling')(nforce);

_.templateSettings.interpolate = /{\/([\s\S]+?)}/g;

var options = {
  headers :  {
    'User-Agent' : 'SFDC-Webhook-Receiver'
  }
};

var org = nforce.createConnection({
  clientId: '3MVG9xOCXq4ID1uGlTQYlYHi9pQpUGaR7Nff25tdrf8iRs5Rr26OTSNYdwWqTMq_BELP7biQ9NhGUkpVVCx5N',
  clientSecret: '4027583954596245018',
  redirectUri: 'http://localhost:3000/oauth/_callback',
  apiVersion: 'v29.0',  // optional, defaults to current salesforce API version
  environment: 'production',  // optional, salesforce 'sandbox' or 'production', production default
  mode: 'multi', // optional, 'single' or 'multi' user mode, multi default
  plugins: ['tooling']
});

var oauth;
org.authenticate({ username: 'bleboff@gmail.com.webhook', password: '1qaz@WSXgYbxHEyXoI1ENy4GME7LmjAI'}, function(err, resp){
  // store the oauth object for this user
  if(!err){
  	oauth = resp;
  }
  	
});


var requestPromise = function(url){
  var deferred = q.defer();

  options.url = url;

  request.get(options, function(error, response, body){
    if (!error && response.statusCode === 200) {
      deferred.resolve(body);
    }
    else{
      deferred.reject(error);
    }
  });
  return deferred.promise;
};

var getCommit = function(commit_url){
  console.log('retrieving commit: ' + commit_url);
  return requestPromise(commit_url);
};
var getFile = function(file_url){
  console.log('retrieving file: ' + file_url);
  return requestPromise(file_url);
};

var getFileName = function(path){
	return path.replace(/^.*(\\|\/|\:)/, '');
};

var getClassName = function(file_name){
	var file_array = file_name.split('.');
	return _.without(file_array, file_array[file_array.length-1]).join('.');
}

var getFileType = function(file_name){
	var ext = file_name.split('.').pop();
	if(ext === 'cls'){
		return 'ApexClass';
	}
	else if(ext === 'page'){
		return 'ApexPage';
	}
	else{
		return 'Unknown';
	}
};

var createContainer = function(name){
	var deferred = q.defer();
	org.tooling.createContainer({name: name, oauth: oauth}, function(err, resp){
		if (err) deferred.reject(err);
    	if (!err) deferred.resolve(resp);
    });

	return deferred.promise;
}

var getClassIds = function(class_names){
	var deferred = q.defer();
	if(class_names.length > 0){
		var qu = 'select id, name from ApexClass where name in ('+class_names+')';

		org.query({ query: qu, oauth: oauth}, function(err, resp){
			if (err) deferred.reject(err);
	    	if (!err) deferred.resolve(resp);
		})
	}
	else{
		deferred.resolve();
	}
	

	return deferred.promise;
}

var addContainerArtifact = function(containerid, artifact){
	var deferred = q.defer();
	
	
	org.tooling.addContainerArtifact({id: containerid, artifact: artifact, oauth: oauth}, function(err, resp) {
	  if (err){
	  	deferred.reject(err);
	  } 
	  if (!err){
	  	deferred.resolve(resp);
	  } 
	});

	return deferred.promise;
}

var deployContainer = function(containerid){
	var deferred = q.defer();
	
	org.tooling.deployContainer({id: containerid, isCheckOnly: false, oauth: oauth}, function(err, resp){
		if(err) deferred.reject(err);
		if(!err) deferred.resolve(resp);
	});

 	return deferred.promise;
}

var getContainerDeployStatus = function(containerid){
	var deferred = q.defer();
	
	org.tooling.getContainerDeployStatus({id: containerid, oauth: oauth}, function(err, resp){
		if(err) deferred.reject(err);
		if(!err) deferred.resolve(resp);
	});

 	return deferred.promise;
}

var getClassNames = function(files){
	var class_names = '';
	_.forEach(files, function(file){
		var file_name = getFileName(file.name);
		if(getFileType(file_name) === 'ApexClass'){
			class_names += '\''+getClassName(file_name)+'\',';
		};
	});

	class_names = class_names.length > 0 ? class_names.slice(0, class_names.length-1) : '';
	return class_names;
}

var checkDeploymentStatus = function(data){
	console.log(data);
	var interval = setInterval(function(){
		console.log('checking status...');
		getContainerDeployStatus(data.id).then(function(data){
			if(data.State != 'Queued'){
				console.log(data.State);
				if(data.ErrorMsg) console.log(data.ErrorMsg);
				if(!_.isEmpty(data.CompilerErrors)) console.log(data.CompilerErrors);
				clearInterval(interval);
			}
			else{
				console.log(data.State);
			}

		}, function(data){
			console.log(data);
		});


	}, 2000);
	

	


}



exports.compileFiles = function(files){
	//get file names
	var deferreds = [];
	
	var class_ids_promise = getClassIds(getClassNames(files));

	var container_promise = createContainer('test-container-35');

	deferreds.push(class_ids_promise);
	deferreds.push(container_promise);

	q.all(deferreds).then(function(data){

		var class_data = data[0].records,
		container_data = data[1], 
		class_names_ids = _.pluck(class_data, '_fields');
		var artifact_deferreds = [];
		_.forEach(files, function(file){
			if(getFileType(file.name) === 'ApexClass'){
				var file_name =  getClassName(getFileName(file.name));
				var class_obj = _.find(class_names_ids, {name : getClassName(getFileName(file.name))});
				var artifact = org.tooling.createDeployArtifact('ApexClassMember', {body: file.data, contentEntityId: class_obj.id});
				artifact_deferreds.push(addContainerArtifact(container_data.id, artifact));
			}
		});


		q.all(artifact_deferreds).then(function(data){
			deployContainer(container_data.id).then(checkDeploymentStatus);
		});

	}, function(err){
		console.log(err);
	});
	
};


exports.getCommitFiles = function(commits_url, commit){
  var commit_deferred = q.defer(),
   commit_url = _.template(commits_url, {'sha': '/'+commit.id});

  getCommit(commit_url).then(function(data){
    var files = JSON.parse(data).files;
    var file_deferreds = [];
    _.forEach(files , function(file){
      var file_deferred = q.defer();
      file_deferreds.push(file_deferred.promise);
      getFile(file.raw_url).then(function(file_data){
        file_deferred.resolve({'name': file.filename, 'data': file_data});
      });
    });
    q.all(file_deferreds).then(commit_deferred.resolve);
  });

  
  return commit_deferred.promise;
};