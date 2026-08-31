const authRouter=require('express').Router();

const getUserProfile=require("../../../controllers/auth/profile");

const auth=require("../../../utils/auth");
const signup=require("../../../controllers/auth/signUp");
const onBoard=require("../../../controllers/auth/onBoard");
const logout=require("../../../controllers/auth/logout");
const login=require("../../../controllers/auth/login");

authRouter.post('/logout',logout);
authRouter.post('/signup',signup);
authRouter.post('/login',login);
authRouter.get('/profile',auth,getUserProfile);
authRouter.post('/onboarding',auth,onBoard);



module.exports=authRouter;