var  q = require('q'),
  request = require('request'),
  _ = require('lodash');


_.templateSettings.interpolate = /{\/([\s\S]+?)}/g;

var options = {
  headers :  {
    'User-Agent' : 'SFDC-Webhook-Receiver'
  }
};


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