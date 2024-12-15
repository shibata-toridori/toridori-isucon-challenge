import crypto from "node:crypto";
import {
  Body,
  Controller,
  Get,
  HttpException,
  NotFoundException,
  Param,
  Post,
  Query,
  Render,
  Req,
  Res,
  Session,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Request, Response } from "express";
import { AppService } from "./app.service";
import type { ReqSession } from "./types";
import { imageUrl } from "./utils";

const POSTS_PER_PAGE = 20;

@Controller()
export class AppController {
  public constructor(private readonly service: AppService) {}

  @Get("/initialize")
  public async initialize(): Promise<string> {
    await this.service.dbInitialize();
    return "ok";
  }

  @Get("/login")
  @Render("login")
  public async loginView(
    @Session() session: ReqSession,
    @Res() res: Response,
    @Req() req: Request,
  ): Promise<object> {
    const me = await this.service.getSessionUser(session);
    if (me != null) {
      res.redirect("/");
      return { me };
    }
    return { me, messages: req.flash() };
  }

  private setSessionUser(session: ReqSession, userId: number): void {
    session.userId = userId;
    session.csrfToken = crypto.randomBytes(16).toString("hex");
  }

  @Post("/login")
  public async login(
    @Body("account_name") accountName: string,
    @Body("password") password: string,
    @Session() session: ReqSession,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const me = await this.service.getSessionUser(session);
    if (me != null) {
      res.redirect("/");
      return;
    }

    const user = await this.service.tryLogin(accountName, password);

    if (user == null) {
      req.flash("notice", "アカウント名かパスワードが間違っています");
      res.redirect("/login");
    } else {
      this.setSessionUser(session, user.id);
      res.redirect("/");
    }
  }

  @Get("/register")
  @Render("register")
  public async registerView(
    @Session() session: ReqSession,
    @Res() res: Response,
    @Req() req: Request,
  ): Promise<object> {
    const me = await this.service.getSessionUser(session);
    if (me != null) {
      res.redirect("/");
      return { me };
    }
    return { me, messages: req.flash() };
  }

  @Post("/register")
  public async register(
    @Body("account_name") accountName: string,
    @Body("password") password: string,
    @Session() session: ReqSession,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const me = await this.service.getSessionUser(session);
    if (me != null) {
      res.redirect("/");
      return;
    }

    try {
      const user = await this.service.registerUser(accountName, password);
      this.setSessionUser(session, user.id);
      res.redirect("/");
    } catch (e) {
      if (e instanceof Error) {
        req.flash("notice", e.message);
        res.redirect("/register");
      }
      return;
    }
  }

  @Get("/logout")
  public logout(@Req() req: Request, @Res() res: Response): void {
    req.session.destroy((error: unknown) => {
      if (error != null) {
        console.error(error);
      }
    });
    res.redirect("/");
  }

  @Get("/@:accountName")
  @Render("user")
  public async user(
    @Param("accountName") accountName: string,
    @Session() session: ReqSession,
  ): Promise<object> {
    const [ me, user ] = await Promise.all([
      this.service.getSessionUser(session),
      this.service.getUserByAccountName(accountName)
    ]);
    if (user == null) {
      throw new NotFoundException("Not Found");
    }
    const posts = await this.service.getPostsByUser(user);
    const postCount = await this.service.getPostCountByUser(user);
    const postExts = await this.service.makePostExts(posts);
    const filteredPosts = this.service.filterPosts(postExts, POSTS_PER_PAGE);
    const commentCount = await this.service.getCommentCountByUser(user);
    const commentedCount = await this.service.getCommentedCountByUser(user);
    return {
      me,
      user,
      posts: filteredPosts,
      post_count: postCount,
      comment_count: commentCount,
      commented_count: commentedCount,
      imageUrl,
    };
  }

  @Get("/")
  @Render("index")
  public async index(
    @Session() session: ReqSession,
    @Req() req: Request,
  ): Promise<object> {
    const [ me, posts ] = await Promise.all([
      this.service.getSessionUser(session),
      this.service.getPosts(POSTS_PER_PAGE)
    ]);
    const postExts = await this.service.makePostExts(posts);
    const filteredPosts = this.service.filterPosts(postExts, POSTS_PER_PAGE);
    return { me, imageUrl, posts: filteredPosts, messages: req.flash() };
  }

  @Get("/posts")
  @Render("posts")
  public async posts(
    @Query("max_created_at") maxCreatedAtString: string,
    @Session() session: ReqSession,
  ): Promise<object> {
    let maxCreatedAt = new Date(maxCreatedAtString);
    if (maxCreatedAt.toString() === "Invalid Date") {
      maxCreatedAt = new Date();
    }
    const [ me, posts ] = await Promise.all([
      this.service.getSessionUser(session),
      this.service.getPosts(POSTS_PER_PAGE, maxCreatedAt)
    ]);
    const postExts = await this.service.makePostExts(posts);
    const filteredPosts = this.service.filterPosts(postExts, POSTS_PER_PAGE);
    return { me, imageUrl, posts: filteredPosts };
  }

  @Get("/posts/:id")
  @Render("post")
  public async post(
    @Param("id") postIdString: string,
    @Session() session: ReqSession,
  ): Promise<object> {
    const [ me, postId ] = await Promise.all([
      this.service.getSessionUser(session),
      Number(postIdString)
    ]);
    const post = await this.service.getPost(postId);
    if (post == null) {
      throw new NotFoundException("Not Found");
    }
    const postExt = await this.service.makePostExt(post, { allComments: true });
    return { me, imageUrl, post: postExt };
  }

  @Post("/")
  @UseInterceptors(FileInterceptor("file"))
  public async postPost(
    @Body("body") body: string,
    @Body("csrf_token") csrfToken: string,
    @Session() session: ReqSession,
    @Res() res: Response,
    @Req() req: Request,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<void> {
    const me = await this.service.getSessionUser(session);
    if (me == null) {
      res.redirect("/login");
      return;
    }

    if (csrfToken !== session.csrfToken) {
      throw new HttpException("invalid CSRF Token", 422);
    }

    if (file == null) {
      req.flash("notice", "画像が必須です");
      res.redirect("/");
      return;
    }

    try {
      const post = await this.service.createPost(me, file, body);
      res.redirect(`/posts/${encodeURIComponent(post.id)}`);
      return;
    } catch (e) {
      if (e instanceof Error) {
        req.flash("notice", e.message);
        res.redirect("/");
      }
      return;
    }
  }

  @Get("/image/:id.:ext")
  public async image(
    @Param("id") idString: string,
    @Param("ext") ext: string,
    @Res() res: Response,
  ): Promise<void> {
    const id = Number(idString);
    const post = await this.service.getPost(id);
    if (post == null) {
      throw new HttpException("image not found", 404);
    }
    if (
      (ext === "jpg" && post.mime === "image/jpeg") ||
      (ext === "png" && post.mime === "image/png") ||
      (ext === "gif" && post.mime === "image/gif")
    ) {
      res.contentType(post.mime);
      res.send(Buffer.from(post.imgdata));
    }
  }

  @Post("/comment")
  public async postComment(
    @Body("post_id") postIdString: string,
    @Body("comment") comment: string,
    @Body("csrf_token") csrfToken: string,
    @Session() session: ReqSession,
    @Res() res: Response,
  ): Promise<void> {
    const me = await this.service.getSessionUser(session);
    if (me == null) {
      res.redirect("/login");
      return;
    }

    if (csrfToken !== session.csrfToken) {
      throw new HttpException("invalid CSRF Token", 422);
    }

    if (!/^[0-9]+$/.test(postIdString)) {
      res.send("post_idは整数のみです");
      return;
    }
    const postId = Number(postIdString);
    await this.service.createComment(me, postId, comment);
    res.redirect(`/posts/${encodeURIComponent(postId)}`);
  }

  @Get("/admin/banned")
  @Render("banned")
  public async banned(
    @Session() session: ReqSession,
    @Res() res: Response,
  ): Promise<object> {
    const me = await this.service.getSessionUser(session);
    if (me == null) {
      res.redirect("/login");
      return { me };
    }

    if (!me.authority) {
      throw new HttpException("authority is required", 403);
    }

    const bannedUsers = await this.service.getBannedUsers();

    return { me, users: bannedUsers };
  }

  @Post("/admin/banned")
  public async postBanned(
    @Body("account_name") accountName: string,
    @Body("csrf_token") csrfToken: string,
    @Body("uid") uid: string[],
    @Session() session: ReqSession,
    @Res() res: Response,
  ): Promise<void> {
    const me = await this.service.getSessionUser(session);
    if (me == null) {
      res.redirect("/");
      return;
    }

    if (!me.authority) {
      throw new HttpException("authority is required", 403);
    }

    if (csrfToken !== session.csrfToken) {
      throw new HttpException("invalid CSRF Token", 422);
    }

    const user = await this.service.getUserByAccountName(accountName);
    if (user == null) {
      throw new HttpException("user not found", 404);
    }

    await Promise.all(
      uid.map((userIdString) => {
        const userId = Number(userIdString);
        return this.service.banUser(userId);
      }),
    );

    res.redirect("/admin/banned");
  }
}
