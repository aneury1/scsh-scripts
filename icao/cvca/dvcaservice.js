/**
 *  ---------
 * |.##> <##.|  Open Smart Card Development Platform (www.openscdp.org)
 * |#       #|  
 * |#       #|  Copyright (c) 1999-2010 CardContact Software & System Consulting
 * |'##> <##'|  Andreas Schwier, 32429 Minden, Germany (www.cardcontact.de)
 *  --------- 
 *
 *  This file is part of OpenSCDP.
 *
 *  OpenSCDP is free software; you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License version 2 as
 *  published by the Free Software Foundation.
 *
 *  OpenSCDP is distributed in the hope that it will be useful,
 *  but WITHOUT ANY WARRANTY; without even the implied warranty of
 *  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *  GNU General Public License for more details.
 *
 *  You should have received a copy of the GNU General Public License
 *  along with OpenSCDP; if not, write to the Free Software
 *  Foundation, Inc., 51 Franklin St, Fifth Floor, Boston, MA  02110-1301  USA
 * 
 * @fileoverview A simple DVCA web service implementing TR-03129 web services
 */



/**
 * Create a DVCA instance with web services
 *
 * @param {String} path the path to the certificate store
 * @param {String} name the holder name (Country code plus holder mnemonic) for this instance
 * @param {String} parent the holder name of the parent CA
 * @param {String} parentURL the URL of the parent CA's webservice
 */ 
function DVCAService(path, name, parent, parentURL) {
	this.name = name;
	this.type = "DVCA";
	
	this.parent = parent;
	this.parentURL = parentURL;
	
	this.crypto = new Crypto();
	
	this.ss = new CVCertificateStore(path);
	this.dvca = new CVCCA(this.crypto, this.ss, name, parent);
	this.path = this.dvca.path;
	this.inqueue = [];
	this.outqueue = [];
	this.outqueuemap = [];
	this.terminalCertificatePolicies = [];
}



/**
 * Sets the URL which is used to receive SendCertificate messages
 * 
 * @param {String} url
 */
DVCAService.prototype.setSendCertificateURL = function(url) {
	this.myURL = url;
}



/**
 * Sets the key specification for generating requests
 *
 * @param {Key} keyparam a key object containing key parameters (e.g. EC Curve)
 * @param {ByteString} algorithm the terminal authentication algorithm object identifier
 */
DVCAService.prototype.setKeySpec = function(keyparam, algorithm) {
	this.cvca.setKeySpec(keyparam, algorithm);
}



/**
 * Sets the policy for issuing terminal certificates
 *
 * @param {Object} policy policy object as defined for CVCCA.prototype.generateCertificate()
 * @param {Regex} chrregex a regular expression that the CHR must match in order to use this rule
 */
DVCAService.prototype.setTerminalCertificatePolicy = function(policy, chrregex) {
	if (typeof(chrregex) != "undefined") {
		this.terminalCertificatePolicies.push( { regex: chrregex, policy: policy } );
	} else {
		this.terminalCertificatePolicy = policy;
	}
}



/**
 * Returns the policy to apply for a given CHR
 *
 * @param {PublicKeyReference} chr the certificate holder reference
 * @returns a matching policy or the default policy
 * @type Object
 */
DVCAService.prototype.getTerminalCertificatePolicyForCHR = function(chr) {
	for (var i = 0; i < this.terminalCertificatePolicies.length; i++) {
		var p = this.terminalCertificatePolicies[i];
		if (chr.toString().match(p.regex)) {
			return p.policy;
		}
	}
	return this.terminalCertificatePolicy;
}



/**
 * Check certificate request syntax
 *
 * @param {ByteString} req the request in binary format
 * @returns the decoded request or null in case of error
 * @type CVC
 */
DVCAService.prototype.checkRequestSyntax = function(reqbin) {
	try	{
		var reqtlv = new ASN1(reqbin);
		var req = new CVC(reqtlv);
	}
	catch(e) {
		GPSystem.trace("Error decoding ASN1 structure of request: " + e);
		return null;
	}
	
	return req;
}



/**
 * Check certificate request semantic
 *
 * @param {CVC} req the request
 * @returns one of the ServiceRequest status results (ok_cert_available if successful).
 * @type String
 */
DVCAService.prototype.checkRequestSemantics = function(req) {
	// Check inner signature
	try	{
		var puk = req.getPublicKey();
	}
	catch(e) {
		GPSystem.trace("Error checking request semantics in " + e.fileName + "#" + e.lineNumber + " : " + e);
		return ServiceRequest.FAILURE_SYNTAX;
	}
	
	if (!req.verifyWith(this.crypto, puk)) {
		GPSystem.trace("Error verifying inner signature");
		return ServiceRequest.FAILURE_INNER_SIGNATURE;
	}
	
	// Check that request key algorithm matches the algorithm for the current certificate
	var chr = this.ss.getCurrentCHR(this.path);
	var cvc = this.ss.getCertificate(this.path, chr);
	var oid = cvc.getPublicKeyOID();
	var reqoid = req.getPublicKeyOID();
	
	if (!reqoid.equals(oid)) {
		GPSystem.trace("Public key algorithm " + reqoid.toString(OID) + " in request does not match current public key algorithm " + oid.toString(OID));
		return ServiceRequest.FAILURE_SYNTAX;
	}
	
	// Check that request key domain parameter match current domain parameter
	var dp = this.ss.getDomainParameter(this.path, chr);
	
	if (!puk.getComponent(Key.ECC_P).equals(dp.getComponent(Key.ECC_P)) ||
		!puk.getComponent(Key.ECC_A).equals(dp.getComponent(Key.ECC_A)) ||
		!puk.getComponent(Key.ECC_B).equals(dp.getComponent(Key.ECC_B)) ||
		!puk.getComponent(Key.ECC_GX).equals(dp.getComponent(Key.ECC_GX)) ||
		!puk.getComponent(Key.ECC_GY).equals(dp.getComponent(Key.ECC_GY)) ||
		!puk.getComponent(Key.ECC_N).equals(dp.getComponent(Key.ECC_N)) ||
		!puk.getComponent(Key.ECC_H).equals(dp.getComponent(Key.ECC_H))) {
		GPSystem.trace("Domain parameter in request do not match current domain parameter");
		return ServiceRequest.FAILURE_SYNTAX;
	}
	
	if (req.isAuthenticatedRequest()) {
		var puk = this.dvca.getAuthenticPublicKey(req.getOuterCAR());
		if (puk) {
			if (!req.verifyATWith(this.crypto, puk)) {
				GPSystem.trace("Error verifying outer signature");
				return ServiceRequest.FAILURE_OUTER_SIGNATURE;
			}
		} else {
			GPSystem.trace("No public key found for authenticated request");
			return ServiceRequest.FAILURE_OUTER_SIGNATURE;
		}
	}
	
	return ServiceRequest.OK_CERT_AVAILABLE;
}



/**
 * Check certificate request against policy
 *
 * @param {CVC} req the request
 * @param {String} returnCode the proposed return code string
 * @param {Boolean} callback the indicator if a call-back is possible
 * @returns one of the ServiceRequest status results (ok_cert_available if successful).
 * @type String
 */
DVCAService.prototype.checkPolicy = function(req, returnCode, callback) {
	if (returnCode != ServiceRequest.OK_CERT_AVAILABLE) {
		return returnCode;
	}
	
	var policy = this.getTerminalCertificatePolicyForCHR(req.getCHR());
	
	if (req.isAuthenticatedRequest()) {
		var cvc = this.dvca.getIssuedCertificate(req.getOuterCAR());
		var now = new Date();
		now.setHours(12, 0, 0, 0);
		if (now.valueOf() > cvc.getCXD().valueOf()) {
			GPSystem.trace("Certificate " + cvc.toString() + " is expired");
			if (policy.declineExpiredAuthenticatedRequest) {
				return ServiceRequest.FAILURE_OUTER_SIGNATURE;
			}
		} else {
			if (policy.authenticatedRequestsApproved) {
				return ServiceRequest.OK_CERT_AVAILABLE;
			}
		}
	} else {
		if (policy.initialRequestsApproved) {
			return ServiceRequest.OK_CERT_AVAILABLE;
		}
	}
	
	return callback ? ServiceRequest.OK_SYNTAX : ServiceRequest.FAILURE_SYNCHRONOUS_PROCESSING_NOT_POSSIBLE;
}



/**
 * Issue certificate for subordinate terminal
 *
 * @param {CVC} req the request
 * @returns the certificate
 * @type CVC
 */
DVCAService.prototype.issueCertificate = function(req) {

	var policy = this.getTerminalCertificatePolicyForCHR(req.getCHR());
	var cert = this.dvca.generateCertificate(req, policy);

	this.dvca.storeCertificate(cert );

	GPSystem.trace("DVCAService - Issued certificate: ");
	GPSystem.trace(cert.getASN1());
	return cert;
}



/**
 * Enumerate all pending service requests to superior systems
 *
 * @returns the pending service requests
 * @type ServiceRequest[]
 */
DVCAService.prototype.listOutboundRequests = function() {
	return this.outqueue;
}



/**
 * Gets the indexed request
 *
 * @param {Number} index the index into the work queue identifying the request
 * @returns the indexed request
 * @type ServiceRequest
 */
DVCAService.prototype.getOutboundRequest = function(index) {
	return this.outqueue[index];
}



/**
 * Adds an outbound request to the internal queue, removing the oldest entry if more than
 * 10 entries are contained
 *
 * @param {ServiceRequest} sr the service request
 */
DVCAService.prototype.addOutboundRequest = function(sr) {
	if (this.outqueue.length >= 10) {
		var oldsr = this.outqueue.shift();
		var msgid = oldsr.getMessageID();
		if (msgid) {
			delete(this.outqueuemap[msgid]);
		}
	}
	this.outqueue.push(sr);
	var msgid = sr.getMessageID();
	if (msgid) {
		this.outqueuemap[msgid] = sr;
	}
}



/**
 * Enumerate all pending service requests from subordinate systems
 *
 * @returns the pending service requests
 * @type ServiceRequest[]
 */
DVCAService.prototype.listInboundRequests = function() {
	return this.inqueue;
}



/**
 * Gets the indexed request
 *
 * @param {Number} index the index into the work queue identifying the request
 * @returns the indexed request
 * @type ServiceRequest
 */
DVCAService.prototype.getInboundRequest = function(index) {
	return this.inqueue[index];
}



/**
 * Process request and send certificates
 *
 * @param {Number} index the index into the work queue identifying the request
 */
DVCAService.prototype.processInboundRequest = function(index) {
	var sr = this.inqueue[index];

	var certlist = [];
	
	if (sr.isCertificateRequest()) {		// RequestCertificate
		if (sr.getStatusInfo() == ServiceRequest.OK_CERT_AVAILABLE) {
			var req = sr.getCertificateRequest();
			var response = this.checkRequestSemantics(req);	// Check request a second time

			if (response == ServiceRequest.OK_CERT_AVAILABLE) {		// Still valid
				certlist = this.determineCertificateList(req);
				var cert = this.issueCertificate(req);
				certlist.push(cert);
			} else {
				GPSystem.trace("Request " + req + " failed secondary check");
				sr.setStatusInfo(response);
			}
		}
	} else {								// GetCertificates
		if (sr.getStatusInfo().substr(0, 3) == "ok_") {
			certlist = this.dvca.getCertificateList();
		}
	}

	this.sendCertificates(sr, certlist);
}



/**
 * Delete a request from the work queue
 *
 * @param {Number} index the index into the work queue
 */
DVCAService.prototype.deleteInboundRequest = function(index) {
	this.inqueue.splice(index, 1);
}



/**
 * Determine the list of certificates to send to the client as part of the certificate request response
 *
 * @param {CVC} req the request
 * @returns the certificate list
 * @type CVC[]
 */
DVCAService.prototype.determineCertificateList = function(req) {
	var car = req.getCAR();
	var chr = this.ss.getCurrentCHR(this.path);
	
	if ((car != null) && car.equals(chr)) {
		return [];
	}
	
	return this.dvca.getCertificateList();
}



/**
 * Send certificates using a webservice call
 *
 * @param {ServiceRequest} serviceRequest the underlying request
 * @param {CVC[]} certificates the list of certificates to send
 */
DVCAService.prototype.sendCertificates = function(serviceRequest, certificates) {

	var soapConnection = new SOAPConnection();

	var ns = new Namespace("uri:EAC-PKI-TermContr-Protocol/1.0");
	var ns1 = new Namespace("uri:eacBT/1.0");

	var request =
		<ns:SendCertificates xmlns:ns={ns} xmlns:ns1={ns1}>
			<messageID>{serviceRequest.getMessageID()}</messageID>
			<statusInfo>{serviceRequest.getStatusInfo()}</statusInfo>
			<certificateSeq>
			</certificateSeq>
		</ns:SendCertificates>;

	var list = request.certificateSeq;

	for (var i = 0; i < certificates.length; i++) {
		var cvc = certificates[i];
		list.certificate += <ns1:certificate xmlns:ns1={ns1}>{cvc.getBytes().toString(BASE64)}</ns1:certificate>
	}

	GPSystem.trace(request);
	
	try	{
		var response = soapConnection.call(serviceRequest.getResponseURL(), request);
	}
	catch(e) {
		GPSystem.trace("SOAP call to " + serviceRequest.getResponseURL() + " failed : " + e);
		throw new GPError("DVCAService", GPError.DEVICE_ERROR, 0, "SendCertificates failed with : " + e);
	}
	
	var result = response.Result.ns1::returnCode.toString();
	
	serviceRequest.setFinalStatusInfo(result);
}



/**
 * Update certificate list from parent CA
 *
 */
DVCAService.prototype.updateCACertificates = function(async) {

	var msgid = null;
	
	if (async) {
		msgid = this.crypto.generateRandom(2).toString(HEX);
	}

	var sr = new ServiceRequest(msgid, this.myURL);
	this.addOutboundRequest(sr);
	
	var certlist = this.getCACertificatesFromCVCA(sr);
	var list = this.dvca.importCertificates(certlist);

	if (list.length > 0) {
		print("Warning: Could not import the following certificates");
		for (var i = 0; i < list.length; i++) {
			print(list[i]);
		}
	}
}



/**
 * Renew certificate through parent CA
 *
 */
DVCAService.prototype.renewCertificate = function(async, forceinitial) {

	var dp = this.ss.getDefaultDomainParameter(this.path);
	var algo = this.ss.getDefaultPublicKeyOID(this.path);
	var car = this.ss.getCurrentCHR(CVCertificateStore.parentPathOf(this.path));
	
	this.dvca.setKeySpec(dp, algo);
	
	// Create a new request
	var req = this.dvca.generateRequest(car, forceinitial);
	print("Request: " + req);
	print(req.getASN1());

	var msgid = null;
	
	if (async) {
		msgid = this.crypto.generateRandom(2).toString(HEX);
	}

	var sr = new ServiceRequest(msgid, this.myURL, req);
	this.addOutboundRequest(sr);

	var certlist = this.requestCertificateFromCVCA(sr);

	if (certlist.length > 0) {
		sr.setFinalStatusInfo("" + certlist.length + " certificates received");
	}
	
	var list = this.dvca.importCertificates(certlist);

	if (list.length > 0) {
		print("Warning: Could not import the following certificates");
		for (var i = 0; i < list.length; i++) {
			print(list[i]);
		}
	}
}



/**
 * Import certificates
 *
 * @param {CVC[]} certlist the list of certificates
 *
 */
DVCAService.prototype.importCertificates = function(certlist) {

	var list = this.dvca.importCertificates(certlist);

	if (list.length > 0) {
		print("Warning: Could not import the following certificates");
		for (var i = 0; i < list.length; i++) {
			print(list[i]);
		}
	}
}



/**
 * Obtain a list of certificates from the parent CA using a web service
 *
 * @param {ServiceRequest} serviceRequest the underlying request
 * @returns a list of certificates
 * @type CVC[]
 */
DVCAService.prototype.getCACertificatesFromCVCA = function(sr) {

	var soapConnection = new SOAPConnection();

	var ns = new Namespace("uri:EAC-PKI-CVCA-Protocol/1.0");
	var ns1 = new Namespace("uri:eacBT/1.0");

	var request =
		<ns:GetCACertificates xmlns:ns={ns} xmlns:ns1={ns1}>
			<callbackIndicator>callback_not_possible</callbackIndicator>
			<messageID>
			</messageID>
			<responseURL>
			</responseURL>
		</ns:GetCACertificates>;

	if (sr.getMessageID()) {
		request.callbackIndicator = "callback_possible";
		request.messageID.ns1::messageID = sr.getMessageID();
		request.responseURL.ns1::string = sr.getResponseURL();
	}
	
	var response = soapConnection.call(this.parentURL, request);
	
	sr.setStatusInfo(response.Result.ns1::returnCode.toString());
	var certlist = [];

	if (response.Result.ns1::returnCode.toString() == ServiceRequest.OK_CERT_AVAILABLE) {
		GPSystem.trace("Received certificates from CVCA:");
		for each (var c in response.Result.ns1::certificateSeq.ns1::certificate) {
			var cvc = new CVC(new ByteString(c, BASE64));
			certlist.push(cvc);
			GPSystem.trace(cvc);
		}
	}

	return certlist;
}



/**
 * Request a certificate from the parent CA using a web service
 *
 * @param {ServiceRequest} serviceRequest the underlying request
 * @returns the new certificates
 * @type CVC[]
 */
DVCAService.prototype.requestCertificateFromCVCA = function(sr) {

	var soapConnection = new SOAPConnection();

	var ns = new Namespace("uri:EAC-PKI-CVCA-Protocol/1.0");
	var ns1 = new Namespace("uri:eacBT/1.0");

	var request =
		<ns:RequestCertificate xmlns:ns={ns} xmlns:ns1={ns1}>
			<callbackIndicator>callback_not_possible</callbackIndicator>
			<messageID>
			</messageID>
			<responseURL>
			</responseURL>
			<certReq>{sr.getCertificateRequest().getBytes().toString(BASE64)}</certReq>
		</ns:RequestCertificate>

	if (sr.getMessageID()) {
		request.callbackIndicator = "callback_possible";
		request.messageID.ns1::messageID = sr.getMessageID();
		request.responseURL.ns1::string = sr.getResponseURL();
	}
		
	try	{
		var response = soapConnection.call(this.parentURL, request);
	}
	catch(e) {
		GPSystem.trace("SOAP call to " + this.parentURL + " failed : " + e);
		throw new GPError("DVCAService", GPError.DEVICE_ERROR, 0, "RequestCertificate failed with : " + e);
	}

	sr.setStatusInfo(response.Result.ns1::returnCode.toString());
	var certlist = [];

	if (response.Result.ns1::returnCode.substr(0, 3) == "ok_") {
		GPSystem.trace("Received certificates from CVCA:");
		for each (var c in response.Result.ns1::certificateSeq.ns1::certificate) {
			var cvc = new CVC(new ByteString(c, BASE64));
			certlist.push(cvc);
			GPSystem.trace(cvc);
		}
	}

	return certlist;
}



/**
 * Webservice that returns the list of certificates for this and superior CAs
 * 
 * @param {XML} soapBody the body of the SOAP message
 * @returns the soapBody of the response
 * @type XML
 */
DVCAService.prototype.GetCACertificates = function(soapBody) {

	// Create empty response
	var ns = new Namespace("uri:EAC-PKI-DV-Protocol/1.0");
	var ns1 = new Namespace("uri:eacBT/1.0");

	var callback = soapBody.callbackIndicator;
	
	var certlist = [];
	var returnCode = ServiceRequest.OK_CERT_AVAILABLE;
	
	if (callback == "callback_possible") {
		var asyncreq = new ServiceRequest(
							soapBody.messageID.ns1::messageID,
							soapBody.responseURL.ns1::string);

		this.inqueue.push(asyncreq);
		var returnCode = ServiceRequest.OK_SYNTAX;
	} else {
		// Add certificate list to response
		certlist = this.dvca.getCertificateList();
	}
	
	var response =
		<ns:GetCACertificatesResult xmlns:ns={ns} xmlns:ns1={ns1}>
			<Result>
				<ns1:returnCode>{returnCode}</ns1:returnCode>
				<!--Optional:-->
				<ns1:certificateSeq>
					<!--Zero or more repetitions:-->
				</ns1:certificateSeq>
			</Result>
		</ns:GetCACertificatesResult>
	
	var list = response.Result.ns1::certificateSeq;

	for (var i = 0; i < certlist.length; i++) {
		var cvc = certlist[i];
		list.certificate += <ns1:certificate xmlns:ns1={ns1}>{cvc.getBytes().toString(BASE64)}</ns1:certificate>
	}

	return response;
}



/**
 * Webservice that issues a new certificate for the submitted request
 * 
 * @param {XML} soapBody the body of the SOAP message
 * @returns the soapBody of the response
 * @type XML
 */
DVCAService.prototype.RequestCertificate = function(soapBody) {
	
	var ns = new Namespace("uri:EAC-PKI-DV-Protocol/1.0");
	var ns1 = new Namespace("uri:eacBT/1.0");

	var certlist = [];

	try	{
		var reqbin = new ByteString(soapBody.certReq, BASE64);

		var req = this.checkRequestSyntax(reqbin);

		if (req == null) {
			var returnCode = ServiceRequest.FAILURE_SYNTAX;
		} else {
			GPSystem.trace("DVCAService - Received certificate request: ");
			GPSystem.trace(req);
	
			var returnCode = this.checkRequestSemantics(req);

			var callback = soapBody.callbackIndicator;
			var returnCode = this.checkPolicy(req, returnCode, (callback == "callback_possible"));

			if (returnCode == ServiceRequest.OK_SYNTAX) {
				var asyncreq = new ServiceRequest(
								soapBody.messageID.ns1::messageID,
								soapBody.responseURL.ns1::string,
								req);

				asyncreq.setStatusInfo(returnCode);
				this.inqueue.push(asyncreq);
			} else {
				if (returnCode == ServiceRequest.OK_CERT_AVAILABLE) {
					certlist = this.determineCertificateList(req);

					var cert = this.issueCertificate(req);
					// Add certificate list to response
					certlist.push(cert);
				}
			}
		}
	}
	catch(e) {
		GPSystem.trace("DVCAService - Error decoding request in " + e.fileName + "#" + e.lineNumber + " : " + e);
		var returnCode = ServiceRequest.FAILURE_SYNTAX;
	}

	var response =
		<ns:RequestCertificateResponse xmlns:ns={ns} xmlns:ns1={ns1}>
			<Result>
				<ns1:returnCode>{returnCode}</ns1:returnCode>
				<!--Optional:-->
				<ns1:certificateSeq>
					<!--Zero or more repetitions:-->
				</ns1:certificateSeq>
			</Result>
		</ns:RequestCertificateResponse>
	
	var list = response.Result.ns1::certificateSeq;

	for (var i = 0; i < certlist.length; i++) {
		var cvc = certlist[i];
		list.certificate += <ns1:certificate xmlns:ns1={ns1}>{cvc.getBytes().toString(BASE64)}</ns1:certificate>
	}

	return response;
}



/**
 * Webservice that receives certificates from parent CA
 * 
 * @param {XML} soapBody the body of the SOAP message
 * @returns the soapBody of the response
 * @type XML
 */
DVCAService.prototype.SendCertificates = function(soapBody) {
	
	var ns = new Namespace("uri:EAC-PKI-DV-Protocol/1.0");
	var ns1 = new Namespace("uri:eacBT/1.0");

	var statusInfo = soapBody.statusInfo.toString();
	var msgid = soapBody.messageID.toString();
	
	var sr = this.outqueuemap[msgid];
	if (sr) {
		sr.setStatusInfo(statusInfo);
		var returnCode = ServiceRequest.OK_RECEIVED_CORRECTLY;

		if (returnCode.substr(0, 3) == "ok_") {
			var certlist = [];
			GPSystem.trace("Received certificates from CVCA:");
			for each (var c in soapBody.certificateSeq.ns1::certificate) {
				try	{
					var cvc = new CVC(new ByteString(c, BASE64));
				}
				catch(e) {
					GPSystem.trace("Error decoding certificate: " + e);
					var returnCode = ServiceRequest.FAILURE_SYNTAX;
					break;
				}
				certlist.push(cvc);
				GPSystem.trace(cvc);
			}

			this.importCertificates(certlist);
		}
		sr.setFinalStatusInfo(returnCode);
	} else {
		returnCode = ServiceRequest.FAILURE_MESSAGEID_UNKNOWN;
	}
	
	var response =
		<ns:SendCertificatesResponse xmlns:ns={ns} xmlns:ns1={ns1}>
			<Result>
				<ns1:returnCode>{returnCode}</ns1:returnCode>
			</Result>
		</ns:SendCertificatesResponse>

	return response;
}
