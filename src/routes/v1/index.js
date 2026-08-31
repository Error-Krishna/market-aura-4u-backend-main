const v1Router = require('express').Router();
const authRouter = require('./auth/authRouter');
const contentRouter=require("./content/genrate");
const socialRouter=require("./socialmediaAccounts/index");
const paymentRouter=require("./payments/paymentRouter");
v1Router.use('/auth',authRouter);
v1Router.use('/auth',socialRouter);
v1Router.use('/content',contentRouter);
v1Router.use('/user',paymentRouter);

module.exports = v1Router;