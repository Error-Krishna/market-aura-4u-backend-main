const socialRouter=require("express").Router();
const auth=require("../../../middleware/auth");

const {instagramLogin, instagramCallback }=require("../../../controllers/auth/authController")
socialRouter.get('/instagram/login', instagramLogin);
socialRouter.get('/instagram/callback',instagramCallback);
module.exports=socialRouter;