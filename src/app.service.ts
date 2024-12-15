import crypto from "node:crypto";
import { Injectable, InternalServerErrorException } from "@nestjs/common";
import { Comment, Post, User } from "@prisma/client";
import { PrismaService } from "./db/prisma.service";
import { CommentExt, PostExt, ReqSession, SessionUser } from "./types";

const UPLOAD_LIMIT = 10 * 1024 * 1024; // 10mb

@Injectable()
export class AppService {
  constructor(private readonly prisma: PrismaService) {}

  async dbInitialize(): Promise<void> {
    try {
      await this.prisma.$executeRaw`DELETE FROM users WHERE id > 1000`;
      await this.prisma.$executeRaw`DELETE FROM posts WHERE id > 10000`;
      await this.prisma.$executeRaw`DELETE FROM comments WHERE id > 100000`;
      await this.prisma.$executeRaw`UPDATE users SET del_flg = 0`;
      await this.prisma
        .$executeRaw`UPDATE users SET del_flg = 1 WHERE id % 50 = 0`;
    } catch (e) {
      console.error(e);
      throw new InternalServerErrorException(e);
    }
  }

  async getSessionUser(session: ReqSession): Promise<SessionUser | null> {
    const userId = session.userId;
    const csrfToken = session.csrfToken;
    if (userId == null || csrfToken == null) {
      return null;
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });
    if (user == null) {
      return null;
    }
    return {
      ...user,
      csrfToken,
    };
  }

  private digest(src: string): string {
    return crypto.createHash("sha512").update(src, "utf8").digest("hex");
  }

  private calculatePasshash(account_name: string, password: string): string {
    const salt = this.digest(account_name);
    const passhash = this.digest(`${password}:${salt}`);
    return passhash;
  }

  async tryLogin(account_name: string, password: string): Promise<User | null> {
    const user = await this.prisma.user.findFirst({
      where: { account_name, del_flg: false },
    });
    if (user != null) {
      const passhash = this.calculatePasshash(account_name, password);
      if (passhash === user.passhash) {
        return user;
      }
    }
    return null;
  }

  async getUser(userId: number): Promise<User | null> {
    return await this.prisma.user.findUnique({ where: { id: userId } });
  }

  private validateUser(account_name: string, password: string): boolean {
    if (
      !(
        /^[0-9a-zA-Z_]{3,}$/.test(account_name) &&
        /^[0-9a-zA-Z_]{6,}$/.test(password)
      )
    ) {
      return false;
    }
    return true;
  }

  async registerUser(account_name: string, password: string): Promise<User> {
    const user = await this.prisma.user.findFirst({
      where: { account_name },
    });

    if (!this.validateUser(account_name, password)) {
      throw new Error("アカウント名は3文字以上、20文字以下です");
    }

    if (user != null) {
      throw new Error("このアカウント名は既に使われています");
    }

    const passhash = this.calculatePasshash(account_name, password);
    return await this.prisma.user.create({
      data: {
        account_name,
        passhash,
        authority: false,
        del_flg: false,
      },
    });
  }

  async makeCommentExt(comment: Comment): Promise<CommentExt> {
    const user = await this.getUser(comment.user_id);
    if (user == null) {
      throw new Error("ユーザーが見つかりません");
    }
    return { ...comment, user };
  }

  async makePostExt(
    post: Post,
    options: { allComments: boolean },
  ): Promise<PostExt> {
    const commentIds = await this.prisma.post.findUnique({
      where: { id: post.id },
    }).Comment({
      select: { id: true },
    });

    if (commentIds == null) {
      throw new Error("コメントが見つかりません");
    }

    const commentCount = commentIds.length;

    const comments = await this.prisma.post.findUnique({
      where: { id: post.id },
    }).Comment({
      orderBy: { created_at: "desc" },
      take: options.allComments ? undefined : 3,
    })

    if (comments == null) {
      throw new Error("コメントが見つかりません");
    }

    const commentExts = await Promise.all(
      comments.map(async (comment) => {
        return await this.makeCommentExt(comment);
      }),
    );

    const postUser = await this.getUser(post.user_id);
    if (postUser == null) {
      throw new Error("ユーザーが見つかりません");
    }

    return {
      ...post,
      commentCount,
      comments: commentExts,
      user: postUser,
    };
  }

  async makePostExts(
    posts: Post[],
    options?: { allComments?: boolean },
  ): Promise<PostExt[]> {
    const optionsWithDefault: { allComments: boolean } = {
      allComments: false,
      ...options,
    };

    if (posts.length === 0) {
      return [];
    }

    return Promise.all(
      posts.map((post) => {
        return this.makePostExt(post, optionsWithDefault);
      }),
    );
  }

  filterPosts(posts: PostExt[], postPerPage: number): PostExt[] {
    return posts.filter((post) => !post.user.del_flg).slice(0, postPerPage);
  }

  async getPosts(POSTS_PER_PAGE?: number, before?: Date): Promise<Post[]> {
    let cursor = 0;
    const posts = [];
    let hasMorePosts = true;
    while (hasMorePosts) {
      const batch = await this.prisma.post.findMany({
        where: {
          created_at: before != null ? { lte: before } : undefined,
        },
        // workaround for https://github.com/prisma/prisma/issues/13864
        take: POSTS_PER_PAGE,
        skip: cursor,
        orderBy: { created_at: "desc" },
      });
      posts.push(...batch);
      cursor += batch.length;
      // hasMorePosts = batch.length === 1000;
      hasMorePosts = false;
    }
    return posts;
  }

  async getPost(postId: number): Promise<Post | null> {
    return await this.prisma.post.findUnique({ where: { id: postId } });
  }

  async getUserByAccountName(account_name: string): Promise<User | null> {
    return await this.prisma.user.findFirst({
      where: { account_name },
    });
  }

  async getPostsByUser(user: User): Promise<Post[]> {
    const res = await this.prisma.user
      .findUnique({ where: { id: user.id } })
      .Post({ orderBy: { created_at: "desc" } });

    return res || [];
  }

  async getPostCountByUser(user: User): Promise<number> {
    const res = await this.prisma.user.findUnique({
      where: { id: user.id },
    }).Post();

    if (res == null) {
      return 0;
    }
    return res.length;
  }

  async getCommentCountByUser(user: User): Promise<number> {
    const res = await this.prisma.user.findUnique({
      where: { id: user.id },
    }).Comment();

    if (res == null) {
      return 0;
    }
    return res.length;
  }

  async getCommentedCountByUser(user: User): Promise<number> {
    const posts = await this.prisma.user.findUnique({
      where: { id: user.id },
    }).Post();
    if (posts == null) {
      return 0;
    }
    const postIds = posts.map((post) => post.id);
    if (postIds.length === 0) {
      return 0;
    }
    const res = await this.prisma.user.findUnique({
      where: { id: user.id },
    }).Comment();

    if (res == null) {
      return 0;
    }

    return res.length;
  }

  async createPost(
    user: User,
    file: Express.Multer.File,
    body: string,
  ): Promise<Post> {
    let mime = "";
    if (file.mimetype.includes("jpeg")) {
      mime = "image/jpeg";
    } else if (file.mimetype.includes("png")) {
      mime = "image/png";
    } else if (file.mimetype.includes("gif")) {
      mime = "image/gif";
    } else {
      throw new Error("投稿できる画像形式はjpgとpngとgifだけです");
    }

    if (file.size > UPLOAD_LIMIT) {
      throw new Error("ファイルサイズが大きすぎます");
    }
    return await this.prisma.post.create({
      data: {
        user_id: user.id,
        mime,
        imgdata: file.buffer,
        body,
      },
    });
  }

  async createComment(
    user: User,
    post_id: number,
    comment: string,
  ): Promise<Comment> {
    return await this.prisma.comment.create({
      data: {
        user_id: user.id,
        post_id,
        comment,
      },
    });
  }

  async getBannedUsers(): Promise<User[]> {
    return await this.prisma.user.findMany({ where: { del_flg: true } });
  }

  async banUser(userId: number): Promise<User> {
    return await this.prisma.user.update({
      where: { id: userId },
      data: { del_flg: true },
    });
  }
}
