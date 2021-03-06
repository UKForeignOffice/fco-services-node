var auth = require('basic-auth'),
    moment = require('moment'),
	TransactionService = require('./../lib/transaction_service');

moment.locale('en-gb');

var journeyDescription = function (res, step) {
	return res.locals.transaction.slug + ':' + step;
};
var capitalise = function (word) {
	return word.toUpperCase();
};
var config = require('./../config/smart_pay.js').config;
/**
 * Cache control middleware filter.
 */
var setExpiry = function (req, res, next) {
	res.setHeader('Cache-Control', 'max-age=1800, public');
	next();
};
/**
 * changed to smart_pay transaction actions
 *
 */
module.exports = {
	middleware: {
		setExpiry: setExpiry,
		findTransaction: TransactionService.findTransaction
	},
	middlewares: [setExpiry, TransactionService.findTransaction],
	rootRedirect: function (req, res) {
		res.redirect(req.url + 'start');
	},
	/**
     * GET /start
     */
	start: function (req, res) {
		if (res.locals.transaction.slug === 'pay-legalisation-post' ||
			res.locals.transaction.slug === 'pay-legalisation-drop-off'){
			console.log('Redirecting postal / premium service to new gov service');
			res.redirect('https://www.gov.uk/get-document-legalised');
		}else {
            global.additionalpayments = false;
            res.render('start', {
                country: (req.query['country'] || ''),
                postalCountry: (req.query['postal_country'] || ''),
                transaction: res.locals.transaction,
                journeyDescription: journeyDescription(res, 'start')
            });
        }
	},

    /**
     * GET /additional-payments
     */
    additionalpayments: function (req, res) {
        global.additionalpayments = true;
        res.render('start', {
            country: (req.query['country'] || ''),
            postalCountry: (req.query['postal_country'] || ''),
            transaction: res.locals.transaction,
            journeyDescription: journeyDescription(res, 'start')
        });
    },
	/**
	 * POST /confirm
	 */
	/**
 * @param req

 */
	confirm: function (req, res) {
		try {
			var transactionService = new TransactionService(res.locals.transaction);
			var calculation = transactionService.calculateTotal(req.body['transaction']);
			var validatedEmail = transactionService.validateEmail(req.body['transaction']);
			var requestParameters = transactionService.buildParameterList(req, calculation.totalCost, validatedEmail, function (merchantReturnData) {
				transactionService.getNextPaymentNumber(res.locals.transaction.slug, function (number) {
					number = number + 1;
					requestParameters.merchantReference = requestParameters.merchantReference + '-' + number;
					requestParameters.merchantReturnData = merchantReturnData;
					var smartPayHmac = transactionService.buildSmartPayRequest(req, requestParameters);
					var smartPayURL = transactionService.getSmartPayURL();
					var encryptedMerchantReturnData = transactionService.encrypt(requestParameters.merchantReturnData);
					var collection = db.collection(config.dbCollection);
					var document = {
						'_id': requestParameters.merchantReference,
						'service': res.locals.transaction.slug,
						'merchantReturnData': encryptedMerchantReturnData,
						'binRange': 1234,
						'pspReference': 0,
						'authorised': 0,
						'captured': 0,
						'cancelled': 0,
						'refunded': 0,
						'authorisationEmail': 0,
						'captureEmail': 0,
						'cancellationEmail': 0,
						'refundEmail': 0,
						'dateAdded': new Date()
					};
					collection.insert(document, {
						w: 1
					}, function (err) {
						if (err) {
							return console.dir(err);
						}
						console.log('Inserted reference ' + requestParameters.merchantReference + ' into database successfully');
						res.render('confirm', {
							calculation: calculation,
							requestParameters: requestParameters,
							smartPayHmac: smartPayHmac,
							smartPayURL: smartPayURL,
							transaction: res.locals.transaction,
							journeyDescription: journeyDescription(res, 'confirm')
						});
					});
				});
			});
		} catch (err) {
			res.render('start', {
				country: req.body['transaction']['country'],
				postalCountry: req.body['transaction']['postal_country'],
				errors: err.message,
				journeyDescription: journeyDescription(res, 'invalid_form')
			});
		}
	},
	/**
	 * GET /done
	 */
	done: function (req, res) {
		try {
			var responseParameters = req.query;
			var transactionService = new TransactionService(res.locals.transaction);
			var merchantSig = responseParameters.merchantSig;
			var smartPayResponse = transactionService.buildSmartPayResponse(req, responseParameters);
			if (transactionService.getVerifiedStatus(merchantSig, smartPayResponse)) {
				var extractedParameters = transactionService.extractParameterList(req, responseParameters, function (merchantReturnDataDecoded) {
					extractedParameters.merchantReturnData = merchantReturnDataDecoded;
					extractedParameters.paymentMethod = transactionService.formatPaymentMethod(extractedParameters.paymentMethod);
					var merchantReturnDataJson = JSON.parse(extractedParameters.merchantReturnData);
					if (extractedParameters.authResult !== 'AUTHORISED') {
						res.render('payment_error', {
							journeyDescription: journeyDescription(res, 'payment_error')
						});
					} else {
						console.log('Reached the done page for ' + extractedParameters.merchantReference);
						var premiumService = '';
						if (res.locals.transaction.slug === 'pay-legalisation-drop-off') {
							premiumService = 'pay-legalisation-premium-service';
						}
						res.render('done', {
							smartPayResponse: smartPayResponse,
							extractedParameters: extractedParameters,
							merchantReturnDataJson: merchantReturnDataJson,
							transaction: res.locals.transaction,
							premiumService: premiumService,
							date: moment().format('LL'),
							journeyDescription: journeyDescription(res, 'done')
						});
					}
				});
			} else {
				throw new Error('Invalid merchant signature');
			}
		} catch (e) {
			res.render('payment_error', {
				journeyDescription: journeyDescription(res, 'payment_error')
			});
		}
	},
	/**
	 * GET /notification
	 */
	notification: function (req, res) {
		/*jshint maxcomplexity:24 */
		/*jshint maxstatements:100*/
		/*jshint maxdepth:5*/
		try {
			var credentials = auth(req);
			if (!credentials || credentials.name !== config.basicAuthUsername || credentials.pass !== config.basicAuthPassword || res.locals.transaction.slug !== config.notificationSlug) {
				console.log('A failed attempt has been made to access the notification service');
				res.write('[accepted]');
				res.end();
			} else {
				var transactionService = new TransactionService(res.locals.transaction),
					body = req.body.notificationItems[0].NotificationRequestItem,
					collection = db.collection(config.dbCollection),
					event = body.eventCode,
					success = body.success,
					merchantAccountCode = body.merchantAccountCode,
					merchantAccountType = capitalise(merchantAccountCode.slice(-4)),
					account = '';
				var emailContents = {
					value: body.amount.value / 100,
					merchantReference: body.merchantReference,
					paymentMethod: transactionService.formatPaymentMethod(body.paymentMethod),
					dataDecodedJson: '',
					emailTemplate: '',
					date: moment().format('LL'),
					emailSubject: '',
					lastFourDigitsOfCard: '',
					emailType: '',
					pspReference: body.pspReference,
					currency: '',
					slug: '',
					fcoOfficeEmailAddress: ''
				};
				var transactionSlug = emailContents.merchantReference.split('-');
				var serviceAndAccounts = transactionService.getServiceFromPaymentReference(transactionSlug[0]);
				emailContents.slug = serviceAndAccounts[0];
				account = serviceAndAccounts[1];
				console.log('Processing a new notification request for ' + emailContents.merchantReference);
				console.log(emailContents.merchantReference + ' is of type ' + event + ' for service ' + emailContents.slug);
				if (event === 'AUTHORISATION' && success === 'true' && emailContents.slug !== '') {
					if (merchantAccountType === 'MOTO') {
						console.log('Begin MOTO processing');
						transactionService.processMOTOPayment(emailContents, body, merchantAccountCode);
					} else {
						console.log('Begin AUTHORISATION processing');
						transactionService.processAuthorisationPayment(emailContents, body, merchantAccountCode, collection);
					}
				}
				if (event === 'CAPTURE' && success === 'true' && emailContents.slug !== '') {
					if (merchantAccountType !== 'MOTO') {
						console.log('Begin CAPTURE processing');
						transactionService.processCapturePayment(emailContents, body, merchantAccountCode, collection, account);
					}
				}
				if (event === 'REFUND' && success === 'true' && emailContents.slug !== '') {
					console.log('Begin REFUND processing');
					if (merchantAccountType !== 'MOTO') {
						transactionService.processRefundPayment(emailContents, body, merchantAccountCode, collection, account);
					}
				}
				if (event === 'CANCELLATION' && success === 'true' && emailContents.slug !== '') {
					if (merchantAccountType !== 'MOTO') {
						console.log('Begin CANCELLATION processing');
						transactionService.processCancellationPayment(emailContents, body, merchantAccountCode, collection, account);
					}
				}
				if (success === 'false') {
					console.log('Notification has not succeeded for ' + emailContents.merchantReference);
				}
				/*Accept payment anyway even if there was an issue*/
				res.write('[accepted]');
				res.end();
			}
		} catch (err) {
			res.write('[accepted]');
			res.end();
			return console.dir(err);
		}
	}
};